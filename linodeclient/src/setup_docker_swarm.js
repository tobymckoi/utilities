"use strict";

const fs = require('fs');

const { forE } = require('./utils.js');


function doDockerSwarmSetup(lapi, linode_servers, ssh_connector, hosts_to_build, setupCallback) {



  prestartConnectPoll();



  function prestartConnectPoll() {

    forE( hosts_to_build, (hostname, next) => {

      pollForStackScriptComplete();

      // Poll SSH until we see the stack script completion file,
      function pollForStackScriptComplete() {
        function pollForComplete() {
          ssh_connector.execCommand( hostname, 'cat /root/ss_completion.txt', (err, stdout, stderr, code) => {
            if (code === 0) {
              console.log(hostname + ": Stack Script completed, proceeding...");
              setTimeout( next, 1000);
            }
            else {
              if (err !== void 0) {
                console.log("(NO SSH YET)");
              }
              console.log(hostname + ": Polling for completion");
              setTimeout( pollForComplete, 5000);
            }
          });
        }
        pollForComplete();
      }

    }, start);

  }



  function start() {
    // Is there a manager set up in the database?
    fs.readFile(linode_servers.db_path + "manager.txt", (err, read_manager) => {
      if (err) {
        // Prime manager doesn't exist so we need to create it.
        // Find the first created host that's a manager,
        let prime_manager;
        for (let i = 0; i < hosts_to_build.length; ++i) {
          const hostname = hosts_to_build[i];
          const host_config = linode_servers.host_config[hostname];
          const swarm_type = host_config.swarm;
          if (swarm_type === 'manager') {
            prime_manager = hostname;
            break;
          }
        }
        if (prime_manager === void 0) {
          setupCallback('ERROR: At least one swarm manager must be provisioned');
        }
        else {
          // Initialize the swarm on this manager since we don't have a 'manager.txt'
          // file.
          fs.writeFile( linode_servers.db_path + "manager.txt", prime_manager, (err) => {
            if (err) {
              setupCallback("ERROR: Failed to write 'manager.txt' file in db");
            }
            else {
              // Read the server details from the manager host,
              lapi.readFromDatabase(prime_manager, (err, server) => {
                if (err) {
                  setupCallback('ERROR: Unable to access from db: ' + prime_manager);
                }
                else {
                  // Get the local IP address for this manager server,
                  const local_ip = server.private_ipv4;
                  // Initialize swarm on this host,
                  ssh_connector.execCommand( prime_manager,
                      'docker swarm init --advertise-addr ' + local_ip + ':2377 ' +
                                        '--listen-addr ' + local_ip + ':2377',
                                      (err, stdout, stderr, code) => {
                    if (err) {
                      setupCallback(err);
                    }
                    else if (code !== 0) {
                      console.log(stdout);
                      console.error(stderr);
                      setupCallback('ERROR: Failed to initialize Docker swarm');
                    }
                    else {
                      // Connect to this server to setup swarm,
                      connectToSwarmManager(prime_manager);
                    }
                  });
                }
              });
            }
          });
        }
      }
      else {
        // Connect to the swarm manager read from 'manager.txt' file,
        connectToSwarmManager( read_manager );
      }
    });
  }



  function connectToSwarmManager( prime_manager ) {
    // Fetch the tokens for connecting workers and managers to the swarm,
    ssh_connector.execCommand( prime_manager, 'docker swarm join-token -q worker',
                    (err, stdout, stderr, code) => {
      if (err) {
        setupCallback(err);
      }
      else if (code !== 0) {
        console.log(stdout);
        console.error(stderr);
        setupCallback("ERROR: Failed SSH exec.");
      }
      else {
        const worker_token = stdout;

        ssh_connector.execCommand( prime_manager,
                  'docker swarm join-token -q manager',
                                    (err, stdout, stderr, code) => {
          if (err) {
            setupCallback(err);
          }
          else if (code !== 0) {
            console.log(stdout);
            console.error(stderr);
            setupCallback("ERROR: Failed SSH exec.");
          }
          else {
            const manager_token = stdout;
            // Read the server details from the manager host,
            lapi.readFromDatabase( prime_manager, (err, server) => {
              if (err) {
                setupCallback('ERROR: Unable to read host: ' + prime_manager);
              }
              else {
                // Get the local IP address for this manager server,
                const local_ip = server.private_ipv4;
                connectBuildHostsToManager(
                          local_ip, manager_token.trim(), worker_token.trim());
              }
            });
          }
        });
      }
    });
  }



  function connectBuildHostsToManager(manager_private_ipv4, manager_token, worker_token) {

    // For each host being built,
    forE( hosts_to_build, (hostname, next) => {

      const host_config = linode_servers.host_config[ hostname ];
      const swarm_type = host_config.swarm;

      lapi.readFromDatabase( hostname, (err, server) => {
        if (err) {
          setupCallback(err);
        }
        else {
          const local_ip = server.private_ipv4;

          // Skip if this is the primary manager server,
          if (local_ip === manager_private_ipv4) {
            next();
          }
          else {

            let join_command;
            if (swarm_type === 'worker') {
              join_command =
                      'docker swarm join --advertise-addr ' + local_ip + ':2377 ' +
                                        '--listen-addr ' + local_ip + ':2377 ' +
                                        '--token ' + worker_token + ' ' +
                                        manager_private_ipv4 + ':2377';
            }
            else if (swarm_type === 'manager') {
              join_command =
                      'docker swarm join --advertise-addr ' + local_ip + ':2377 ' +
                                        '--listen-addr ' + local_ip + ':2377 ' +
                                        '--token ' + manager_token + ' ' +
                                        manager_private_ipv4 + ':2377';
            }
            else {
              setupCallback('ERROR: Unknown swarm type: ' + swarm_type);
            }

            // Before we join make sure there's a small pause to let the
            // network settle.
            setTimeout( () => {
              // Execute the 'docker swarm join' command,
              ssh_connector.execCommand(hostname, join_command,
                                            (err, stdout, stderr, code) => {
                if (err) {
                  setupCallback(err);
                }
                else if (code !== 0) {
                  console.log(stdout);
                  console.error(stderr);
                  setupCallback("ERROR: Failed SSH exec.");
                }
                else {
                  // Go to next host,
                  next();
                }
              });
            }, 4000);

          }

        }
      });

    }, finish);

  }


  function finish() {
    // All done,
    setupCallback(undefined);
  }


}



module.exports = doDockerSwarmSetup;
