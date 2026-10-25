# The relay as a NixOS service. It acts for no one, so it runs as a user of
# its own, which reaches nothing but its database. It listens on 127.0.0.1
# only, and the host puts a front before it, such as a reverse proxy.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.byoa-relay;
in {
  options.services.byoa-relay = {
    enable = lib.mkEnableOption "the byoa relay";
    port = lib.mkOption {
      type = lib.types.port;
      default = 8790;
      description = "The port the relay listens on, on 127.0.0.1.";
    };
  };

  config.systemd.services.byoa-relay = lib.mkIf cfg.enable {
    description = "The byoa relay";
    after = ["network.target"];
    wantedBy = ["multi-user.target"];
    environment = {
      BYOA_ADDRESS = "127.0.0.1:${toString cfg.port}";
      BYOA_DATABASE = "/var/lib/byoa-relay/relay.db";
    };
    serviceConfig = {
      ExecStart = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      Restart = "on-failure";
      DynamicUser = true;
      StateDirectory = "byoa-relay";
      ProtectHome = true;
      PrivateDevices = true;
      ProtectClock = true;
      ProtectControlGroups = true;
      ProtectHostname = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      ProtectProc = "invisible";
      CapabilityBoundingSet = "";
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      RestrictAddressFamilies = ["AF_INET" "AF_INET6"];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = ["@system-service" "~@privileged"];
      UMask = "0077";
    };
  };
}
