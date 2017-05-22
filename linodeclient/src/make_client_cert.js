"use strict";

const readline = require('readline');
const fs = require('fs');
const fse = require('fs-extra');
const spawn = require('child_process').spawn;
const mkdirp = require('mkdirp');

const { loadLinodeServersFile, checkCertFilesAccess } = require('./utils.js');

const config = require('../config.js');
const openssl_exec = config.openssl_exec;


// Read lines from console,
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

// Load the configuration file,

let linode_servers;
let cert_path;
let private_passphrase;
let dest_client_cert_path;


// function introducePause(fun) {
//   return () => {
//     rl.question('Enter to continue...', (answer) => {
//       fun();
//     });
//   }
// }

function hardFail(err) {
  console.error(err);
  process.exit(1);
}

// Read the linode servers JSON file,
// PENDING: Put this into a command line argument?

loadLinodeServersFile( './linode_servers_config.js', (err, in_servers) => {
  linode_servers = in_servers;
  cert_path = linode_servers.cert_path;

  // Check,
  checkCertFilesAccess(cert_path, (err, exists) => {
    if (exists) {
      makeClientCert();
    }
    else {
      hardFail("ERROR: The 'certs' directory does not exist");
    }
  });

} );



function spawnOpenSSL(args, ssl_passphrase, callback) {

  // Make a copy of 'process.env' and set 'PASSPH' property to the
  // pass phrase the user entered;
  // This keeps the plain text passphrase string from being reported in exec
  // logs and process dumps.
  const new_env = JSON.parse(JSON.stringify(process.env));
  new_env['SSLDPASSPH'] = ssl_passphrase;

  const options = {
    cwd: undefined,
    env: new_env
  };

  const openssl = spawn( openssl_exec, args, options );
  openssl.stdout.on('data', (data) => {
    console.log(data.toString());
  });
  openssl.stderr.on('data', (data) => {
    console.error(data.toString());
  });
  openssl.on('close', callback);
}


function makeClientCert() {
  rl.question('Alias for client certificate (eg. name of person): ', (answer) => {
    if (answer.length < 2 || answer.length > 50) {
      makeClientCert();
    }
    else if (!(answer.match(/^[a-z0-9]+$/))) {
      makeClientCert();
    }
    else {
      const npath = './clientcerts/' + answer;
      fs.access(npath, (err) => {
        if (err) {
          // Make the directory,
          mkdirp(npath, (err) => {
            dest_client_cert_path = npath;
            askPrivatePassphrase();
          });
        }
        else {
          console.log("ERROR: Path already exists: %j", answer);
          makeClientCert();
        }
      });
    }
  });
}


function askPrivatePassphrase() {

  console.log();

  rl.question("Enter the SSL private passphrase: ", (answer) => {
    // Check the private key passphrase given is correct,
    spawnOpenSSL( [ 'rsa', '-check', '-noout',
                    '-in', cert_path + "ca-key.pem",
                    '-passin', 'env:SSLDPASSPH'
                  ], answer, (code) => {
      if (code !== 0) {
        console.log('OpenSSL failed for this passphrase.');
        askPrivatePassphrase();
      }
      else {
        private_passphrase = answer;
        buildClientKey();
      }
    });
  });

}


function buildClientKey() {

  spawnOpenSSL( [ 'genrsa',
                  '-out', dest_client_cert_path + '/key.pem',
                  '4096' ], private_passphrase, (code) => {
    if (code !== 0) {
      console.log('OpenSSL failed');
      process.exit(-1);
    }
    else {
      createSigningRequest();
    }
  });

}


function createSigningRequest() {

  spawnOpenSSL( [ 'req',
                  '-subj', "/CN=client",
                  '-new',
                  '-key', dest_client_cert_path + '/key.pem',
                  '-out', dest_client_cert_path + '/client.csr'
                ],
                private_passphrase, (code) => {
    if (code !== 0) {
      console.log('OpenSSL failed');
      process.exit(-1);
    }
    else {
      signCertificate();
    }
  });

}


function signCertificate() {

  spawnOpenSSL( [ 'x509',
                  '-req',
                  '-days', '36500',
                  '-sha256',
                  '-in', dest_client_cert_path + '/client.csr',
                  '-CA', cert_path + "ca.pem",
                  '-CAkey', cert_path + "ca-key.pem",
                  '-CAcreateserial',
                  '-out', dest_client_cert_path + '/cert.pem',
                  '-extfile', './clientcerts/extfile.cnf',
                  '-passin', 'env:SSLDPASSPH'
                ],
                private_passphrase, (code) => {
    if (code !== 0) {
      console.log('OpenSSL failed');
      process.exit(-1);
    }
    else {
      copySharedCert();
    }
  });

}


function copySharedCert() {
  console.log("Copy ca.pem");
  fse.copy( cert_path + "ca.pem", dest_client_cert_path + '/ca.pem',
            (err) => {
    if (err) {
      hardFail("Unable to copy ca.pem");
    }
    else {
      fs.unlink(dest_client_cert_path + '/client.csr', finishKeyGen);
    }
  });
}


function finishKeyGen() {

  console.log("Client Cert generation finished.");

  console.log();
  console.log("Key information in: %j", dest_client_cert_path);

  process.exit(0);

}
