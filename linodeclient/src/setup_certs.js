"use strict";

const fs = require('fs');
const mkdirp = require('mkdirp');

const config = require('../config.js');

const { spawnOpenSSL } = require('./utils.js');

// Module that can SSH into a server and sign a server certificate, then
// reset various modules.
//
// NOTE: This does not have any dependencies on hosting provider. All it
//   needs is a secure shell login in order to prepare the server.

// lapi (function):
// linode_servers (map):
// ssh_connector (function):
// private_passphrase (string):

// hardFail (function): A function that terminates the current process
//    because of a failure.
// private_key_path (string): The location of the private key pem file.
// ca_cert_path (string): The location of the public master certificate pem.
// private_passphrase (string): Pre-verified private key for signing
//    certificates with the private key.

module.exports = function( lapi, linode_servers, ssh_connector, private_passphrase ) {

  const cert_path = linode_servers.cert_path;
  const private_key_path = cert_path + 'ca-key.pem';
  const ca_cert_path = cert_path + 'ca.pem';

  return function( host, complete ) {

    // The unique scratch path for the host,
    const scratch_path = config.scratch_path + host;

    const fqdn = host + '.' + linode_servers.domain_name;
    let public_ipv4;
    let private_ipv4;

    // Read server details from DB,
    lapi.readFromDatabase( host, ( err, server ) => {
      if (err) {
        complete(err);
      }
      else {
        public_ipv4 = server.public_ipv4;
        private_ipv4 = server.private_ipv4;
        createScratchPath();
      }
    });

    // Create the scratch path,
    function createScratchPath() {
      mkdirp(scratch_path + '/', (err) => {
        createServerCerts();
      });
    }


    function simpleOpenSSL(to_exec, callback) {
      spawnOpenSSL( to_exec, private_passphrase, (err, stdout, stderr, code) => {
        if (err) {
          console.log(stdout);
          console.error(stderr);
          complete(err);
        }
        else if (code !== 0) {
          console.log(stdout);
          console.error(stderr);
          complete(Error('ERROR: OpenSSL reported an error.'));
        }
        else {
          console.log(host + ": OpenSSL completed!");
          callback();
        }
      });
    }


    function createServerCerts() {
      // openssl genrsa -out server-key.pem 4096
      simpleOpenSSL(  [
              'genrsa', '-out', scratch_path + "/server-key.pem", '4096'
                      ], () => {
        simpleOpenSSL(  [
                'req', '-subj', '/CN=' + fqdn,
                '-sha256', '-new',
                '-key', scratch_path + "/server-key.pem",
                '-out', scratch_path + "/server.csr"
                        ], () => {

          const ext_file_path = scratch_path + "/extfile.cnf";
          let ext_data = 'subjectAltName = ';
          ext_data += 'DNS:' + fqdn;
          ext_data += ',DNS:localhost';
          ext_data += ',IP:' + public_ipv4;
          ext_data += ',IP:' + private_ipv4;
          ext_data += ',IP:127.0.0.1';

          fs.writeFile( ext_file_path, ext_data, (err) => {
            if (err) {
              complete(err);
            }
            else {
              // openssl x509 -req -days 365 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem
              //  -CAcreateserial -out server-cert.pem -extfile extfile.cnf
              simpleOpenSSL(  [
                      'x509', '-req', '-days', '36500', '-sha256',
                      '-in', scratch_path + "/server.csr",
                      '-CA', ca_cert_path,
                      '-CAkey', private_key_path,
                      '-CAcreateserial',
                      '-out', scratch_path + "/server-cert.pem",
                      '-extfile', scratch_path + "/extfile.cnf",
                      '-passin', 'env:SSLDPASSPH'
                              ], pollForStackScriptComplete );
            }
          });
        });
      });
    }


    // Poll SSH until we see the stack script completion file,
    function pollForStackScriptComplete() {
      function pollForComplete() {
        ssh_connector.execCommand( host, 'cat /root/ss_completion.txt',
                    (err, stdout, stderr, code) => {
          if (code === 0) {
            console.log(host + ": Stack Script completed, proceeding...");
            setTimeout( signCertificates, 1000 );
          }
          else {
            if (err !== void 0) {
              console.log("(NO SSH YET)");
            }
            console.log(host + ": Polling for completion");
            setTimeout( pollForComplete, 5000);
          }
        });
      }
      pollForComplete();
    }


    // openssl x509 -req -days 36500 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem  \
    //   -CAcreateserial -out server-cert.pem -extfile extfile.cnf

    function signCertificates() {
      simpleOpenSSL(  [
              'x509', '-req', '-days', '36500', '-sha256',
              '-in', scratch_path + "/server.csr",
              '-CA', ca_cert_path,
              '-CAkey', private_key_path,
              '-CAcreateserial',
              '-out', scratch_path + "/server-cert.pem",
              '-extfile', scratch_path + "/extfile.cnf",
              '-passin', 'env:SSLDPASSPH'
                      ], uploadSignedFiles );
    }


    function uploadSignedFiles() {
      // Upload the certificates to the server,
      ssh_connector.upload( host,
              scratch_path + "/server-key.pem", "/root/scert/server-key.pem", (err) => {
        if (err) {
          complete(err);
        }
        else {
          ssh_connector.upload( host,
                scratch_path + "/server-cert.pem", "/root/scert/server-cert.pem", (err) => {
            if (err) {
              complete(err);
            }
            else {
              ssh_connector.upload( host,
                    ca_cert_path, "/root/scert/ca.pem", (err) => {
                if (err) {
                  complete(err);
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
      console.log(host + ": Finalizing Docker Installation...");

      ssh_connector.execCommand( host, "/root/docker_finalize.sh",
                      (err, stdout, stderr, code) => {

        console.log(stdout);
        console.error(stderr);
        if (err) {
          complete(err);
        }
        else if (code !== 0) {
          complete(Error('"docker_finalize.sh" script failed'));
        }
        else {
          completedOperation();
        }

      });

    }


    function completedOperation() {
      console.log(host + ": Ok, all done!");
      complete(undefined, host);
    }

  };

}
