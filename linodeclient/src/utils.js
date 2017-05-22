"use strict";

// Various utility functions that support the API.

const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;

const config = require('../config.js');
const openssl_exec = config.openssl_exec;

// Iterates over the array 'arr' and calls 'oncall' for each element. The
// 'oncall' function has parameters (entity, next). The user code calls
// 'next' to progress to the next entity in the array. When the array
// has iterated over every entity, the 'completecall' function is called.

function forE(arr, oncall, completecall) {
  let i = 0;
  let next;
  function ecall() {
    if (i < arr.length) {
      oncall(arr[i], next);
    }
    else {
      completecall();
    }
  }
  next = function() {
    ++i;
    ecall();
  };
  ecall();
}

// Given an array of files, checks that the user has permission to access
// the file. If not, the 'callback' function is invoked with an error
// parameter.

function checkFilesExist(files, callback) {
  forE(files, (file, next) => {
    fs.access(file, (err) => {
      if (err) {
        callback(err);
      }
      else {
        next();
      }
    });
  }, callback);
}

// Load the Linode servers file.

function loadLinodeServersFile(linode_servers_file, callback) {
  // Load the linode servers file using 'require'
  callback( undefined, require( path.join( process.cwd(), linode_servers_file ) ) );
}

function checkCertFilesAccess(cert_path, callback) {
  checkFilesExist( [ cert_path + "ca-key.pem", cert_path + "ca.pem" ], (err) => {
    if (err) {
      callback(undefined, false);
    }
    else {
      // Ok, good to go,
      callback(undefined, true);
    }
  });
}


// Run an SSL command locally,
// eg. to_exec =
//        [ 'x509', '-req', '-days', '36500', '-sha256',
//         '-in', scratch_path + "/server.csr",
//         '-CA', ca_cert_path,
//         '-CAkey', private_key_path,
//         '-CAcreateserial',
//         '-out', scratch_path + "/server-cert.pem",
//         '-extfile', scratch_path + "/extfile.cnf",
//         '-passin', 'env:SSLDPASSPH'
//        ]

function spawnOpenSSL( to_exec, private_passphrase, callback ) {

  console.log("OpenSSL exec: %j", to_exec)

  // Make a copy of 'process.env' and set 'PASSPH' property to the
  // pass phrase the user entered;
  // This keeps the plain text passphrase string from being reported in exec
  // logs and process dumps.
  const new_env = JSON.parse( JSON.stringify( process.env ) );
  new_env['SSLDPASSPH'] = private_passphrase;

  const options = {
    cwd: undefined,
    env: new_env
  };

  let stdout = '';
  let stderr = '';

  const openssl = spawn( openssl_exec, to_exec, options );
  openssl.stdout.on('data', (data) => {
    stdout += data.toString();
  });
  openssl.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  openssl.on('close', (code) => {
    if (code !== 0) {
      callback( Error('ERROR: OpenSSL reported an error.') );
    }
    else {
      callback( undefined, stdout, stderr, code );
    }
  });

}







// Export the functions,
module.exports = {
  forE,
  checkFilesExist,
  loadLinodeServersFile,
  checkCertFilesAccess,
  spawnOpenSSL,
};
