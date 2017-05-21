"use strict";

// Deletes Linode instances that were previously created using these tools.

const readline = require('readline');
const fs = require('fs');

const { forE, loadLinodeServersFile, checkCertFilesAccess } = require('./utils.js');
const config = require('../config.js');

console.log();
console.log("Linode Docker Delete Tool");
console.log("-------------------------");
console.log();
console.log("DELETES Linodes from a Linode account that were previously created with");
console.log("the 'provision_dockers' command.");
console.log();
console.log("NOTE: USE THIS TOOL WITH CARE. YOU ARE DELETING VMs THAT MAY HAVE DATA");
console.log("  ON THEM YOU DON'T WANT TO DELETE.");
console.log();

// Read lines from console,
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

// Load the configuration file,

let linode_servers;


function introducePause(fun) {
  return () => {
    rl.question('Enter to continue...', (answer) => {
      fun();
    });
  }
}

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

  let linodes_list;
  let domainlist;

  connectToLinode();

  function connectToLinode() {

    const batch = [];

    batch.push( ['linode.list', {}, (answer) => {
      linodes_list = answer.DATA;
    }] );
    batch.push( ['domain.list', {}, (answer) => {
      domainlist = answer.DATA;
    }] );

    linodeAPICallBatch(batch, queryDB);

  }

  const local_db = {};
  const hosts_list_db = [];

  function withFieldEqual(arr, field, label) {
    for (let i = 0; i < arr.length; ++i) {
      if (arr[i][field] === label) {
        return arr[i];
      }
    }
    return null;
  }

  function getLinodeWithLabel(label) {
    return withFieldEqual(linodes_list, 'LABEL', label);
  }

  function getDomainRecord(domain_name) {
    const dr = withFieldEqual(domainlist, 'DOMAIN', domain_name);
    if (dr !== null) {
      return dr;
    }
    hardFail("Linode master domain record not found: " + domain_name);
  }

  function queryDB() {
    const db_path = linode_servers.db_path;
    fs.readdir(db_path, (err, items) => {
      if (err) {
        hardFail(err);
      }
      else {
        forE(items, (hostname, next) => {
          if (hostname === 'manager.txt') {
            next();
          }
          else {
            fs.readFile(db_path + hostname, (err, data) => {
              if (err) {
                hardFail(err);
              }
              else {
                const jsd = JSON.parse(data);
                local_db[hostname] = jsd;
                hosts_list_db.push(jsd);
                next();
              }
            });
          }
        }, confirmWithUser);
      }
    });
  }


  function confirmWithUser() {

//    // The linodes we have access to,
//    console.log(linodes_list);
//    console.log(local_db);

    console.log("Summary of servers in database;")

    let i = 1;
    for (const host in local_db) {
      const public_ip = local_db[host].public_ipv4;
      console.log("  " + i + ": %j IP: %j", host, public_ip);
      ++i;
    }

    if (i === 1) {
      console.log("No servers to delete.");
      process.exit(0);
    }
    else {

      console.log();
      console.log("Enter a comma separated list of servers to delete.");
      console.log("For example; 2,4,5");

      askForServers();
    }
  }

  let servers_list;

  function askForServers() {

    rl.question("Servers to delete: ", (answer) => {
      const servers = answer.split(",");
      servers_list = [];
      for (let i = 0; i < servers.length; ++i) {
        const snum = servers[i];
        if (snum.trim().length > 0) {
          const si = parseInt(snum);
          if (servers_list.indexOf(si) >= 0) {
            console.log("Error: Repeated server index: %j", si);
            askForServers();
            return;
          }
          else if (si < 1 || si > hosts_list_db.length) {
            console.log("Error: Server index out of range: %j", si);
            askForServers();
            return;
          }
          else {
            servers_list.push(si);
          }
        }
      };

      confirmDelete();
    });

  }

  let hosts_to_delete;

  function confirmDelete() {

    console.log();

    if (servers_list.length === 0) {
      console.log("Not deleting anything. Bye.");
      process.exit(0);
    }
    else {

      console.log("Continuing will DELETE the following servers;");
      let i = 1;
      hosts_to_delete = [];
      for (const host in local_db) {
        if (servers_list.indexOf(i) >= 0) {
          const public_ip = local_db[host].public_ipv4;
          console.log("  %j IP: %j", host, public_ip);
          hosts_to_delete.push(host);
        }
        ++i;
      }

      console.log();
      rl.question("DELETE all data on these servers (y/N)? ", (answer) => {
        if (answer !== 'y') {
          console.log("OK, not deleting the servers. Bye!");
          process.exit(0);
        }
        else {
          // Secondary confirmation,
          proceedToDelete();
        }
      });

    }

  }

  const working = {};
  let domain_record;

  function proceedToDelete() {

    domain_record = getDomainRecord(linode_servers.domain_name);

    for (let i = 0; i < hosts_to_delete.length; ++i) {
      const hostname = hosts_to_delete[i];

      const linode_data = getLinodeWithLabel(hostname);
      const linode_id = linode_data.LINODEID;

      working[hostname] = {
        linode_id,
        linode_data,
        domain_record
      };
    }

    downloadDomainInfo();

  }



  function downloadDomainInfo() {
    lapi.linodeAPICall('domain.resource.list', { DomainID: domain_record.DOMAINID },
            (answer) => {
      const data = answer.DATA;
      for (let i = 0; i < data.length; ++i) {
        hosts_to_delete.forEach((host) => {
          if (data[i].NAME === host) {
            let arr = working[host].dns_to_remove;
            if (arr === void 0) {
              arr = [];
              working[host].dns_to_remove = arr;
            }
            arr.push(data[i].RESOURCEID);
          }
        });
      }
//      provisionComplete();
      removeDNS();
    });
  }


  function removeDNS() {
    forEachLinode(working, hosts_to_delete, (host, hostob) => {
      // Remove the DNS record,
      if (hostob.dns_to_remove && hostob.dns_to_remove.length > 0) {
        return {
          call: {
            action: 'domain.resource.delete',
            params: {
              DomainID: hostob.domain_record.DOMAINID,
              ResourceID: hostob.dns_to_remove[0],
            }
          },
          result: (data) => {
          }
        };
      }
      else {
        return;
      }
    }, removeLinodes);
  }


  function removeLinodes() {

    const db_path = linode_servers.db_path;

    // Remove the manager file if it exists,
    fs.unlink(db_path + 'manager.txt', (err) => {

      forEachLinode(working, hosts_to_delete, (host, hostob) => {
        // Delete the Linode,
        return {
          call: {
            action: 'linode.delete',
            params: {
              LinodeID: hostob.linode_id,
              skipChecks: true
            }
          },
          result: (data) => {
            // On sucessful delete, remove the local host record,
            fs.unlink(db_path + host, (err) => {
            });
          }
        };
      }, provisionComplete);

    });

  }


  function provisionComplete() {

    console.log();
    console.log("Delete operation complete...");
    console.log();
    process.exit(0);

//    console.log(working);
  }


}
