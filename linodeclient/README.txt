
Creates and initializes a Docker swarm on a Linode account.

To use this the following files must be created;

  ./certs/ca-key.pem
  ./certs/ca.pem
  ./linode_servers_config.js

The 'ca-key.pem' and 'ca.pem' files can be created with the following
OpenSSL commands;

  openssl genrsa -aes256 -out ./certs/ca-key.pem 4096
  openssl req -new -x509 -days 36500 -key ./certs/ca-key.pem \
    -sha256 -out ./certs/ca.pem

The Linode account must also have permission to run the Docker installation
StackScripts.

Copy 'example_linode_servers_config.js' to 'linode_servers_config.js' and
edit as necessary for your configuration.
