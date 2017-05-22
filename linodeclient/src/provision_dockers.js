"use strict";

// Provisions a number of Docker servers on a Linode account. Creates server side
// certificates for the docker daemons. The signing process happens client side so
// the private key does not travel over the internet or hit the memory space of
// external machines.

// The provision description is loaded from the 'linode_servers.json' file.

const readline = require('readline');
const spawn = require('child_process').spawn;
const mkdirp = require('mkdirp');

const { forE, loadLinodeServersFile, checkCertFilesAccess } = require('./utils.js');

const config = require('../config.js');
const openssl_exec = config.openssl_exec;


console.log();
console.log("Linode Docker Provision Tool");
console.log("----------------------------");
console.log();
console.log("Provisions a number of VM instances from Linode with Docker installations.");
console.log("NOTE: This tool will add linodes to your account.");
console.log();

// Read lines from console,
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

// Load the configuration file,

let linode_servers;


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

  // Do we check if cert files exist?
  if (linode_servers.dockertls === 'on') {
    // Check,
    checkCertFilesAccess(linode_servers.cert_path, (err, exists) => {
      if (exists) {
        toLinode();
      }
      else {
        hardFail("ERROR: The 'certs' directory does not exist");
      }
    });
  }
  else if (linode_servers.dockertls === 'off') {
    toLinode();
  }
  else {
    hardFail('ERROR: Unknown config property: dockertls=on|off');
  }
});



function toLinode() {

  const lapi = require('./api.js')( linode_servers );
  const { forEachLinode, linodeAPICallBatch } = lapi;

  let datacenters;
  let distributions;
  let linodeplans;
  let stackscripts;
  let kernels;
  let domainlist;

  let linodes_list;
  let hosts_existing = [];
  let hosts_to_build = [];

  let private_passphrase;

  connectToLinode();


  function connectToLinode() {

    const batch = [];

    batch.push( ['avail.datacenters', {}, (answer) => {
      datacenters = answer.DATA;
    }] );
    batch.push( ['avail.distributions', {}, (answer) => {
      distributions = answer.DATA;
    }] );
    batch.push( ['avail.linodeplans', {}, (answer) => {
      linodeplans = answer.DATA;
    }] );
    batch.push( ['avail.kernels', { isXen:false, isKVM:true }, (answer) => {
      kernels = answer.DATA;
    }] );
    batch.push( ['stackscript.list', {}, (answer) => {
      stackscripts = answer.DATA;
    }] );
    batch.push( ['linode.list', {}, (answer) => {
      linodes_list = answer.DATA;
    }] );
    batch.push( ['domain.list', {}, (answer) => {
      domainlist = answer.DATA;
    }] );

    linodeAPICallBatch(batch, hostsScan);

  }

  function withFieldEqual(arr, field, label) {
    for (let i = 0; i < arr.length; ++i) {
      if (arr[i][field] === label) {
        return arr[i];
      }
    }
    return null;
  }

  function getLinodePlan(label) {
    const plan = withFieldEqual(linodeplans, 'LABEL', label);
    if (plan !== null) {
      return plan;
    }
    hardFail("Linode plan not found: " + label);
  }

  function getLinodeWithLabel(label) {
    return withFieldEqual(linodes_list, 'LABEL', label);
  }

  function getLinodeDataCenter(abbr) {
    const dc = withFieldEqual(datacenters, 'ABBR', abbr);
    if (dc !== null) {
      return dc;
    }
    hardFail("Linode datacenter not found: " + abbr);
  }

  function getDistribution(label) {
    const dist = withFieldEqual(distributions, 'LABEL', label);
    if (dist !== null) {
      return dist;
    }
    hardFail("Linode distribution not found: " + label);
  }

  function getStackScript(label) {
    const ss = withFieldEqual(stackscripts, 'LABEL', label);
    if (ss !== null) {
      return ss;
    }
    hardFail("Linode Stack Script not found: " + label);
  }

  function getLatestKernel() {
    for (let i = 0; i < kernels.length; ++i) {
      if (kernels[i].LABEL.startsWith('Latest 64 bit (')) {
        return kernels[i];
      }
    }
    return null;
  }

  function getGrub2Kernel() {
    for (let i = 0; i < kernels.length; ++i) {
      if (kernels[i].LABEL === 'GRUB 2') {
        return kernels[i];
      }
    }
    return null;
  }

  function getDomainRecord(domain_name) {
    const dr = withFieldEqual(domainlist, 'DOMAIN', domain_name);
    if (dr !== null) {
      return dr;
    }
    hardFail("Linode master domain record not found: " + domain_name);
  }



  function hostsScan() {
    // Don't provision servers that already exist,
  //  const hosts = linode_servers.hosts;

    forE(linode_servers.hosts, (host, next) => {

      const linode_data = getLinodeWithLabel(host);
      if (linode_data === null) {
        // Not found, so we create it,
        hosts_to_build.push(host);
      }
      else {
        hosts_existing.push(host);
      }

      next();

    }, startProvision);

  }


  function startProvision() {

    console.log("Skipping %j because they already exist.", hosts_existing);
    console.log();

    if (hosts_to_build.length === 0) {
      console.log("There's nothing to provision!");
      process.exit(0);
    }

    // Make the db directory if it doesn't exist,
    mkdirp(linode_servers.db_path, (err) => {

      console.log("I will be provisioning the following servers from Linode:");
      for (let i = 0; i < hosts_to_build.length; ++i) {
        const hostname = hosts_to_build[i];
        const linode_type = linode_servers.host_config[hostname].type;
        const linode_plan = getLinodePlan(linode_type);
        console.log(hostname + ": '" + linode_type + "' ($" + linode_plan.PRICE + " per month)");
      }

      console.log();

      rl.question('Are you sure you wish to continue (y/N)? ', (answer) => {
        if (answer !== 'y') {
          console.log("Ok, bye!");
          process.exit(0);
        }
        else {
          // Ask for cert password,
          askPrivatePassphrase();
        }
      });

    });

  }


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


  function askPrivatePassphrase() {

    console.log();

    if (linode_servers.dockertls === 'on') {
      rl.question("Enter the SSL private passphrase: ", (answer) => {

        // Check the private key passphrase given is correct,
        const cert_path = linode_servers.cert_path
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
            startProvisioning();
          }
        });

      });
    }
    else {
      private_passphrase = null;
      startProvisioning();
    }
  }




  const working = {};

  function startProvisioning() {
    console.log("Provisioning servers on Linode...");

    const distro = linode_servers.distro;

    let linode_distribution;
    let stack_script_label;
    if (distro === 'Debian 8') {
      linode_distribution = 'Debian 8';
      stack_script_label = 'Debian 8 Docker Development';
    }
    else if (distro === 'Ubuntu 16.10') {
      linode_distribution = 'Ubuntu 16.10';
      stack_script_label = 'Ubuntu 16.10 Docker Development';
    }
    else {
      hardFail('Unknown distribution: ' + distro);
    }

    // Ok, lets start provisioning the servers for real using the Linode
    // API.

    for (let i = 0; i < hosts_to_build.length; ++i) {
      const hostname = hosts_to_build[i];

      const linode_config = linode_servers.host_config[hostname];

      // The plan type and root password,
      const linode_plan_type = linode_config.type;
      const docker_swarm_type = linode_config.swarm;
      const linode_root_pass = linode_config.password;

      // Get the linode plan,
      const plan = getLinodePlan(linode_plan_type);
      // Get the linode datacenter,
      const datacenter = getLinodeDataCenter('london');

      const udf_json_string = JSON.stringify(
        { hostname: hostname, domain: linode_servers.domain_name }
      );

      const debian_dist_id = getDistribution(linode_distribution).DISTRIBUTIONID;

      const stack_script_id = getStackScript(stack_script_label).STACKSCRIPTID;

//      const kernel_id = getLatestKernel().KERNELID;
      const kernel_id = getGrub2Kernel().KERNELID;

      const domain_record = getDomainRecord(linode_servers.domain_name);


      // Calculate disk size of this plan,
      const plan_size_in_mb = plan.DISK * 1024;
      // How many MB we give to swap,
      const swap_size_in_mb = 256;
      // How many MB left for everything else,
      const distro_size_in_mb = plan_size_in_mb - swap_size_in_mb;


      working[hostname] = {
        docker_swarm_type,
        linode_root_pass,
        plan, datacenter,
        disk_ids: [],
        swap_size_in_mb,
        distro_size_in_mb,

        stack_script_id,
        udf_json_string,
        debian_dist_id,
        kernel_id,

        domain_record
      };
    }

    createLinodes();
  }


  function createLinodes() {
    // Create each Linode VM,
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.create',
          params: {
            DatacenterID: hostob.datacenter.DATACENTERID,
            PlanID: hostob.plan.PLANID
          }
        },
        result: (data) => {
          hostob.LinodeID = data.LinodeID
        }
      };
    }, updateLabels );
  }

  //  console.log(working);

  // Set the label and display group for each Linode VM,
  function updateLabels() {
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.update',
          params: {
            LinodeID: hostob.LinodeID,
            Label: host,
            lpm_displayGroup: 'Docker Cluster'
          }
        },
        result: (data) => {
        }
      };
    }, addPrivateIP );
  }

  // Add private IP address for each Linode VM,
  function addPrivateIP() {
    // Add a private ip address for this Linode,
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.ip.addprivate',
          params: {
            LinodeID: hostob.LinodeID,
          }
        },
        result: (data) => {
          hostob.private_ipv4 = data.IPADDRESS;
        }
      };
    }, queryIPs );
  }

  function queryIPs() {
    // Add a private ip address for this Linode,
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.ip.list',
          params: {
            LinodeID: hostob.LinodeID,
          }
        },
        result: (data) => {
          data.forEach((v) => {
            if (v.ISPUBLIC === 1) {
              if (hostob.public_ipv4 === void 0) {
                hostob.public_ipv4 = v.IPADDRESS;
              }
              else {
                hardFail(Error('Multiple public IP addresses on server'));
              }
            }
          });
        }
      };
    }, updateDatabase );
  }

  function updateDatabase() {
    forE(hosts_to_build, (host, next) => {

      const linode_config = linode_servers.host_config[host];
      const hostob = working[host];
      const map = {
        hostname: host,
        plan_type: linode_config.type,
        root_pass: working[host].linode_root_pass,
        public_ipv4: hostob.public_ipv4,
        private_ipv4: hostob.private_ipv4
      };
      lapi.writeToDatabase(host, map, next);

    }, buildStackScriptDisk );
  }

  // Build stack script disk,
  function buildStackScriptDisk() {
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.disk.createfromstackscript',
          params: {
            LinodeID: hostob.LinodeID,
            StackScriptID: hostob.stack_script_id,
            StackScriptUDFResponses: hostob.udf_json_string,
            DistributionID: hostob.debian_dist_id,
            Label: linode_servers.distro,  // eg. 'Debian 8'
            Size: hostob.distro_size_in_mb,
            rootPass: hostob.linode_root_pass,
          }
        },
        result: (data) => {
          hostob.create_maind_job = data.JobID;
          hostob.disk_ids.push(data.DiskID);
        }
      };
    }, buildSwapDisk );
  }

  // Build swap disk,
  function buildSwapDisk() {
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.disk.create',
          params: {
            LinodeID: hostob.LinodeID,
            Label: '256MB Swap Image',
            Type: 'swap',
            Size: hostob.swap_size_in_mb
          }
        },
        result: (data) => {
          hostob.create_swapd_job = data.JobID;
          hostob.disk_ids.push(data.DiskID);
        }
      };
    }, buildConfig );
  }

  // Build config for this node,
  function buildConfig() {
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.config.create',
          params: {
            LinodeID: hostob.LinodeID,
            KernelID: hostob.kernel_id,
            Label: 'Docker Config',
            Comments: 'Created via console script.',
            DiskList: hostob.disk_ids.join(),
            helper_network: true
          }
        },
        result: (data) => {
          hostob.ConfigID = data.ConfigID
        }
      };
    }, bootLinode );
  }

  // Now boot the node,
  function bootLinode() {
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      return {
        call: {
          action: 'linode.boot',
          params: {
            LinodeID: hostob.LinodeID,
            ConfigID: hostob.ConfigID
          }
        },
        result: (data) => {
          hostob.boot_job = data.JobID
        }
      };
    }, waitForBootJobs );
  }


  function waitForBootJobs() {
    forE(hosts_to_build, (hostname, nextForE) => {

      const hostob = working[hostname];
      lapi.monitorBootJob(hostob.LinodeID, hostob.boot_job, (data, nextPoll) => {

        console.log("Waiting on %j to finish boot.", hostname);
  //        console.log(data);
  //        console.log("HOST_SUCCESS = %j", data.HOST_SUCCESS);
  //        console.log("" + typeof data.HOST_SUCCESS);

        if (data.HOST_SUCCESS === 1) {
          const finish_date_time = data.HOST_FINISH_DT;
          console.log(hostname + ": Boot finished at " + finish_date_time);

          // Wait for next boot,
          nextForE();

        }
        else {
          nextPoll();
        }

      });

    }, setupDNS);

  }


  // Set up the DNS records,
  function setupDNS() {
    forEachLinode(working, hosts_to_build, (host, hostob) => {
      // Create the A record for this FQDN
      return {
        call: {
          action: 'domain.resource.create',
          params: {
            DomainID: hostob.domain_record.DOMAINID,
            Type: 'A',
            Name: host + "." + linode_servers.domain_name,
            Target: hostob.public_ipv4,
            TTL_sec: 3600
          }
        },
        result: (data) => {
          hostob.domain_resource_resourceid = data.ResourceID
        }
      };
    }, provisionComplete);
  }



  function provisionComplete() {

    // Ok, The Linode(s) provision part has been completed.
    // Right now the linodes should be booting up using the Docker stack script.
    // After a short wait, we have to open a SSH connection to each server and
    // poll the filesystem until we know the server boot process has completed.
    // Once the stack script has completed, we go ahead and sign the server certs
    // with our private key.

    console.log();
    console.log("Waiting 10 seconds for server boot process to complete before");
    console.log("trying SSH.");

    setTimeout( () => {

      loginWithSSH();

    }, 10000);

  }

  // The SSH connector,
  let ssh_connector;

  // Using SSH, login to the servers and finish the certificate signing process
  // for Docker.
  function loginWithSSH() {

    // Create the SSH connector,
    ssh_connector = lapi.createSSHConnector();

    if (linode_servers.dockertls === 'on') {

      // PENDING: Selectively assign security to certain hosts,
      const hosts_to_give_remote = [];
      hosts_to_build.forEach( (host) => {
        hosts_to_give_remote.push( host );
      });

      const manageCertsWithSSH = require('./setup_certs.js')(
                lapi, linode_servers, ssh_connector, private_passphrase );

      const completed_ssh = [];

      hosts_to_give_remote.forEach( (host) => {
        manageCertsWithSSH( host, (err, host) => {
          if (err) {
            hardFail(err);
          }
          else if (completed_ssh.indexOf(host) < 0) {
            completed_ssh.push(host);
            if (completed_ssh.length === hosts_to_give_remote.length) {
              setupDockerSwarm();
            }
          }
          else {
            hardFail("ERROR: Host completed twice: %j", host);
          }
        });
      });

    }
    else {
      setupDockerSwarm();
    }

  }






  // Log into the servers and set up the docker swarm as necessary.
  function setupDockerSwarm() {

    const doDockerSwarmSetup = require('./setup_docker_swarm.js');
    doDockerSwarmSetup(lapi, linode_servers, ssh_connector, hosts_to_build, (err) => {
      if (err) {
        hardFail(err);
      }
      else {
        completedScript();
      }
    });

  }





  function completedScript() {
    console.log();
    console.log('Finished!');
    process.exit(0);
  }

}
