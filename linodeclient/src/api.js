"use strict";

// API for the Linode client access.
// Use;
//   const api = require('./api.js')(linode_servers_config);
// Then;
//   api.linodeAPICall
//   api.linodeAPICallBatch

const request   = require('request');
const fs        = require('fs');
const SSHClient = require('ssh2').Client;

const { forE } = require('./utils.js');


module.exports = function API( linode_servers_config ) {

  // Makes a call to the Linode API,
  function linodeAPICall(action, params, callback) {

    const formData = {
      api_key: linode_servers_config.linode_api,
      api_action: action
    };
    for (let k in params) {
      formData[k] = params[k].toString();
    }

    request.post( { url:'https://api.linode.com/', formData:formData },
                              (err, httpResponse, body) => {
      const answer = JSON.parse(body);
      if (answer.ERRORARRAY.length > 0) {
        console.error("FAILED BECAUSE ERROR");
        console.error(answer.ERRORARRAY);
        process.exit(-1);
      }
      else {
        callback(answer);
      }
    });

  }

  // Batches a number of calls to the Linode API,
  function linodeAPICallBatch(batch, afterBatchCall) {
    forE(batch, (cmds, next) => {
      linodeAPICall(cmds[0], cmds[1], (answer) => {
        cmds[2](answer);
        next();
      });
    }, afterBatchCall);
  }

  // Iterates over every Linode server in the hosts array. The 'working' object
  // represents a map of the dataset being worked on.
  function forEachLinode(working, hosts, fore, next) {

    // For each host in hosts,
    forE( hosts, ( host, forENext ) => {

      const hostob = working[host];

      const r = fore( host, hostob );

      if (r === null || r === void 0) {

        forENext();

      }
      else {

        // Get the Linode API call and the result function,
        const linode_api_call = r.call;
        const result_fun = r.result;

        console.log("EXEC LINODE COMMAND: ");
        console.log(linode_api_call);

        linodeAPICall(
                linode_api_call.action, linode_api_call.params, (result) => {
          console.log("RESULT: ");
          console.log(result.DATA);

          result_fun(result.DATA);

          forENext();
        });

      }

    }, next);

  }



  // Periodically polls the job id and reports the result via the 'callback'
  // function. The callback function is; (data, nextPoll)
  function monitorBootJob(linode_id, job_id, callback) {

    let nextPoll;

    function doJobCheck() {

      linodeAPICall( 'linode.job.list', { LinodeID: linode_id, JobID: job_id },
                     (answer) => {

        callback(answer.DATA[0], nextPoll);

      } );

    }

    nextPoll = function() {
      // Poll against after 5 seconds,
      setTimeout( doJobCheck, 5000 );
    }

    doJobCheck();

  }



  // ---- Local Persistent Database Start ----
  // PENDING: Turn this into its own object?

  const local_db = {};

  function mergeTuples(field, tuples) {
    const map = local_db[field];
    if (map === undefined) {
      local_db[field] = tuples;
    }
    else {
      for (const key in tuples) {
        map[key] = tuples[key];
      }
    }
    return JSON.parse( JSON.stringify( local_db[field] ) );
  }

  function readFromDatabase(host, callback) {
    let map = local_db[host];
    if (map === void 0) {
      // Read from file,
      fs.readFile(linode_servers_config.db_path + host, (err, data) => {
        if (err) {
          callback(undefined, mergeTuples( host, {} ));
        }
        else {
          callback(undefined, mergeTuples( host, JSON.parse(data) ));
        }
      });
    }
    else {
      callback(undefined, JSON.parse(JSON.stringify(map)));
    }
  }

  function writeToDatabase(host, tuples, callback) {

    readFromDatabase(host, (err, map) => {
      const write_map = mergeTuples( host, tuples );
      // Write the db file,
      fs.writeFile( linode_servers_config.db_path + host,
                    JSON.stringify( write_map ), (err) => {
        if (err) {
          callback(err);
        }
        else {
          callback();
        }
      });
    });

  }

  // ---- Local Persistent Database End ----




  // Returns an object that can be used to issues commands through an SSH
  // connection to the host with the given name. The commands are executed by
  // host name where the IP and SSH password are derived from information
  // stored in the ./db directory.

  // getServerDetails( host, ( err, server ) => { ... } )
  //
  //    Makes a request for the host's details. On success, 'server' will have
  //    available at least the following properties;
  //       public_ipv4  = the IP address string of the SSH server with host
  //                      name.
  //       root_pass    = the password for 'root' user on the server.

  function internalCreateSSHConnector( getServerDetails ) {

    const ssh_db = {};

    // Fetches an SSH connection for the given host name,
    function fetchConnection(host, callback) {

      let connection = ssh_db[host];
      let first_call = false;
      if (connection === void 0) {
        connection = new SSHClient();
        ssh_db[host] = connection;
        first_call = true;
      }

      if (connection.linc_ready === true) {
        callback(undefined, connection);
      }
      else if (connection.linc_failed !== void 0) {
        callback(connection.linc_failed);
      }
      else {
        let called_callback = false;
        connection.on('ready', () => {
          if (connection.linc_ready !== true) {
            console.log(host + ": Connection established.");
          }
          connection.linc_ready = true;
          called_callback = true;
          callback(undefined, connection);
        });
        connection.on('error', (err) => {
          if (connection.linc_fflag !== true) {
            delete ssh_db[host];
          }
          connection.linc_failed = err;
          connection.linc_fflag = true;
          if (!called_callback) {
            called_callback = true;
            callback(err);
          }
          else {
            console.error(err);
          }
        });
      }

      // If this is the first call then try and establish the
      // connection.
      if (first_call) {

        getServerDetails(host, (err, server) => {
          if (err) {
            callback('ERROR: Unable to read host: ' + host);
          }
          else {
            const root_password = server.root_pass;
            const public_ipv4 = server.public_ipv4;

            connection.connect({
              host: public_ipv4,
              port: 22,
              username: 'root',
              password: root_password
            });

          }
        });

      }

    }

    // Executes the command on the given host using SSH to connect to the
    // server.
    function execCommand(host, to_exec, callback) {
      fetchConnection(host, (err, connection) => {
        if (err) {
          callback(err);
        }
        else {
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
              callback(err);
            }
            else {
              let stdout = '';
              let stderr = '';
              stream.on('close', (code, signal) => {
                callback( undefined, stdout, stderr, code );
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
      });
    }

    function upload(host, local_file, rmt_file, callback) {
      fs.readFile(local_file, ( err, data ) => {
        if (err) {
          callback(err);
        }
        else {
          console.log("%s:   UPLOAD: %s -> %s", host, local_file, rmt_file);

          // Remove \r from string just incase of DOS newline weirdness,
          data = data.toString().replace(/\r/g, '');

          // Upload server cert file to the server,
          const cmd_string =
            'cat > ' + rmt_file + ' << CERTEOFNNVVOMP\n' +
            data +
            '\nCERTEOFNNVVOMP';

          execCommand( host, cmd_string, (err, stdout, stderr, code) => {
            if (err) {
              console.log(stdout);
              console.error(stderr);
              callback(err);
            }
            else if (code !== 0) {
              console.log(stdout);
              console.error(stderr);
              callback(Error('Upload failed.'));
            }
            else {
              callback(undefined);
            }
          });
        }
      });
    }

    // API provided,
    return {
      // execCommand ( host, shell_command_to_execute, callback );
      //   callback = ( err, stdout, stderr, code ) => { ... }
      execCommand,
      // upload ( local_file, rmt_file, callback );
      //    callback = ( err )
      upload,
    }

  }

  // Returns a connector for making clients that talk with SSH servers.

  function createSSHConnector() {
    const getServerDetails = readFromDatabase;
    return internalCreateSSHConnector( getServerDetails );
  }



  // External API,
  return {

    linodeAPICall,
    linodeAPICallBatch,
    forEachLinode,
    monitorBootJob,

    readFromDatabase,
    writeToDatabase,
    createSSHConnector

  };

}
