"use strict";

module.exports = {
  
  // The Linode API key. This must be an active key to an account,
  linode_api: "< Your Account Linode API >",
  
  // The top level domain name,
  domain_name: "< Top level domain name (eg; blaggop.com) >",
  // The certs directory if 'dockertls' is enabled,
  cert_path: "./certs/",
  // The database path for storing information about the cluster,
  db_path: "./db/",
  // The Linux distribution,
  distro: "Ubuntu 16.10",
  
  // Set to 'on' to enable remote access to managers via tls settings in docker,
  dockertls: "off",

  // The servers from 'host_config' that are to be provisioned,
  hosts: [ "dev100", "dev101", "dev102" ],
  
  // Define the host servers,
  host_config: {

    dev100: {
      type: "Linode 1024",
      swarm: "manager",
      password: "< password dev100 >"
    },
    dev101: {
      type: "Linode 1024",
      swarm: "manager",
      password: "< password dev101 >"
    },
    dev102: {
      type: "Linode 1024",
      swarm: "manager",
      password: "< password dev102 >"
    },
    // NOTE: This one doesn't get provisioned
    dev103: {
      type: "Linode 1024",
      swarm: "worker",
      password: "< password dev103 >"
    }
    
  }
  
};
