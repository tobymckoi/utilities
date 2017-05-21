"use strict";

const SSHClient = require('ssh2').Client;
const fs = require('fs');
const spawn = require('child_process').spawn;

const mkdirp = require('mkdirp');

const config = require('../config.js');
const openssl_exec = config.openssl_exec;

// Module that can SSH into a server and sign a server certificate, then
// reset various modules.
//
// NOTE: This does not have any dependencies on hosting provider. All it
//   needs is a secure shell login in order to prepare the server.

// hardFail (function): A function that terminates the current process
//    because of a failure.
// private_key_path (string): The location of the private key pem file.
// ca_cert_path (string): The location of the public master certificate pem.
// private_passphrase (string): Pre-verified private key for signing
//    certificates with the private key.

module.exports = function( hardFail, private_key_path, ca_cert_path, private_passphrase ) {

  return function( login_ipv4, private_ipv4, root_pass, host, complete ) {

    // The unique scratch path for the host,
    const scratch_path = config.scratch_path + host;

    createScratchPath();

    // Create the scratch path,
    function createScratchPath() {
      mkdirp(scratch_path + '/', (err) => {
        attemptConnectSSH();
      });
    }


    function execCommand(connection, to_exec, callback) {
      const nldelim = to_exec.indexOf('\n');
      let report_exec;
      if (nldelim >= 0) {
        report_exec = to_exec.substring(0, nldelim) + " (text truncated)";
      }
      else {
        report_exec = to_exec;
      }
      console.log(host + ":   REMOTE EXEC: %j", report_exec);

      connection.exec(to_exec, (err, stream) => {
        if (err) {
          hardFail(err);
        }
        else {
          let stdout = '';
          let stderr = '';
          stream.on('close', (code, signal) => {
            callback(stdout, stderr, code);
          });
          stream.on('data', (data) => {
            stdout += data.toString();
          });
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
        }
      });

    }


    function download(connection, rmt_file, local_file, callback) {
      execCommand(connection, 'cat ' + rmt_file, (stdout, stderr, code) => {
        if (code !== 0) {
          console.error(stderr);
          hardFail(Error('Failed to execute "cat" command'));
        }
        else {
          fs.writeFile(local_file, stdout, (err) => {
            if (err) {
              hardFail(err);
            }
            else {
              console.log(host + ":   DOWNLOAD: %j", local_file);
              callback();
            }
          });
        }
      });
    }



    // Attempt to connection to SSH
    function attemptConnectSSH() {
      console.log(host + ": Attempting to connect to SSH...");

      let server_csr;
      let server_key_pem;
      let extfile_cnf;

      const connection = new SSHClient();
      connection.on('ready', () => {
        console.log(host + ": Connection established.");

        pollForStackScriptComplete();

        // Poll SSH until we see the stack script completion file,
        function pollForStackScriptComplete() {
          function pollForComplete() {
            execCommand(connection, 'cat /root/ss_completion.txt', (stdout, stderr, code) => {
              if (code === 0) {
                console.log(host + ": Stack Script completed, proceeding...");
                setTimeout(downloadServerCertFiles, 5000);
              }
              else {
                console.log(host + ": Polling for completion");
                setTimeout(pollForComplete, 5000);
              }
            });
          }
          pollForComplete();
        }

        function downloadServerCertFiles() {
          download(connection, '/root/scert/server.csr', scratch_path + "/server.csr", () => {
            download(connection, '/root/scert/server-key.pem', scratch_path + "/server-key.pem", () => {
              download(connection, '/root/scert/extfile.cnf', scratch_path + "/extfile.cnf", () => {
                console.log(host + ": Files downloaded to scratch. Running openssl to sign...");
                signCertificates();
              });
            });
          });
        }

        // openssl x509 -req -days 36500 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem  \
        //   -CAcreateserial -out server-cert.pem -extfile extfile.cnf

        function signCertificates() {

          // Make a copy of 'process.env' and set 'PASSPH' property to the
          // pass phrase the user entered;
          // This keeps the plain text passphrase string from being reported in exec
          // logs and process dumps.
          const new_env = JSON.parse(JSON.stringify(process.env));
          new_env['SSLDPASSPH'] = private_passphrase;

          const options = {
            cwd: undefined,
            env: new_env
          };

          const openssl = spawn( openssl_exec,
               [ 'x509', '-req', '-days', '36500', '-sha256',
                 '-in', scratch_path + "/server.csr",
                 '-CA', ca_cert_path,
                 '-CAkey', private_key_path,
                 '-CAcreateserial',
                 '-out', scratch_path + "/server-cert.pem",
                 '-extfile', scratch_path + "/extfile.cnf",
                 '-passin', 'env:SSLDPASSPH'
                ], options );
          openssl.stdout.on('data', (data) => {
            console.log(data.toString());
          });
          openssl.stderr.on('data', (data) => {
            console.error(data.toString());
          });
          openssl.on('close', (code) => {
            if (code !== 0) {
              hardFail(Error('ERROR: OpenSSL reported an error.'));
            }
            else {
              console.log(host + ": OpenSSL completed!");
              uploadSignedFiles();
            }
          });
        }

        function uploadSignedFiles() {
          console.log(host + ": Uploading 'server-cert.pem' to the server.");
          fs.readFile(scratch_path + "/server-cert.pem", (err, data) => {
            if (err) {
              hardFail(err);
            }
            else {
              console.log(host + ":   UPLOAD: /root/scert/server-cert.pem");

              // Remove \r from string just incase of DOS newline weirdness,
              data = data.toString().replace(/\r/g, '');

              // Upload server cert file to the server,
              const cmd_string =
                'cat > /root/scert/server-cert.pem << CERTEOFNNVV\n' +
                data +
                '\nCERTEOFNNVV';

              execCommand(connection, cmd_string, (stdout, stderr, code) => {
                if (code !== 0) {
                  console.error(stderr);
                  hardFail(Error('Upload failed.'));
                }
                else {

                  // Delete the csr file,
                  execCommand(connection, 'rm /root/scert/server.csr', (stdout, stderr, code) => {
                    if (code !== 0) {
                      console.error(stderr);
                      hardFail(Error('Unable to delete server.csr'));
                    }
                    else {
                      restartDocker();
                    }
                  });

                }
              });

            }
          });
        }

        function restartDocker() {
          console.log(host + ": Restarting Docker...");
          execCommand(connection, 'systemctl daemon-reload', (stdout, stderr, code) => {
            if (code !== 0) {
              console.error(stderr);
              hardFail(Error('Failed to reload systemctl daemon'));
            }
            else {
              console.log(stdout);
              execCommand(connection, 'systemctl restart docker', (stdout, stderr, code) => {
                if (code !== 0) {
                  console.error(stderr);
                  hardFail(Error('Failed to restart Docker'));
                }
                else {
                  console.log(stdout);
                  completedOperation();
                }
              });
            }
          });

        }

        function completedOperation() {
          console.log(host + ": Ok, all done!");
          complete(host);
        }


      });
      connection.on('error', hardFail);
      connection.connect({
        host: login_ipv4,
        port: 22,
        username: 'root',
        password: root_pass
      });
    }

  };

}



