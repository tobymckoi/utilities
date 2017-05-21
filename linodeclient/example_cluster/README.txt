
This directory is an example cluster. Before provisioning servers, you must
edit the 'linode_servers_config.js' file and change the properties there as
necessary.

It's recommended you create your own directory to setup your own cluster.
Before using, the following files must be created;

  ./certs/ca-key.pem
  ./certs/ca.pem
  ./linode_servers_config.js

The 'ca-key.pem' and 'ca.pem' files can be created with the following
commands;

  mkdir certs
  openssl genrsa -aes256 -out ./certs/ca-key.pem 4096
  openssl req -new -x509 -days 36500 -key ./certs/ca-key.pem \
    -sha256 -out ./certs/ca.pem

The Linode account must also have permission to run the Docker installation
StackScripts.

To provision servers, use the following command;

  node ../src/provision_dockers.js

To cleanup the provisioned servers, use;

  node ../src/clear_dockers.js

To create client certificates for authenticating with the servers remotely
use the following command;

  node ../src/make_client_cert.js
