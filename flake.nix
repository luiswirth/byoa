{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    rust-overlay,
    treefmt-nix,
    ...
  }: let
    forEachSystem = f:
      nixpkgs.lib.genAttrs ["aarch64-darwin" "x86_64-linux"]
      (system:
        f (import nixpkgs {
          inherit system;
          overlays = [(import rust-overlay)];
        }));

    # The one toolchain, which the shell and the package share.
    rust = pkgs: pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

    # One environment, entered by the shell and by the checks alike. The
    # TypeScript compiler is pinned by pnpm instead, since editors look for it
    # in node_modules.
    tools = pkgs: with pkgs; [(rust pkgs) nodejs pnpm biome just curl jq openssl];
  in {
    packages = forEachSystem (pkgs: {
      default =
        (pkgs.makeRustPlatform {
          cargo = rust pkgs;
          rustc = rust pkgs;
        }).buildRustPackage {
          pname = "polylogue-relay";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [./Cargo.toml ./Cargo.lock ./relay ./polylogue ./transport.md ./extensions];
          };
          cargoLock.lockFile = ./Cargo.lock;
          # The binary names the toolchain's sources, in panic messages, which
          # would pull all of it into whatever runs the relay.
          nativeBuildInputs = [pkgs.removeReferencesTo];
          postFixup = "remove-references-to -t ${rust pkgs} $out/bin/polylogue-relay";
          disallowedReferences = [(rust pkgs)];
          meta.mainProgram = "polylogue-relay";
        };
    });

    nixosModules.relay = import ./nixos-module.nix self;

    # Every language in the tree, behind one command. The global pre-commit
    # hook checks a repository by running this, so a language left out here is
    # a language nothing checks.
    formatter = forEachSystem (pkgs:
      treefmt-nix.lib.mkWrapper pkgs {
        projectRootFile = "flake.nix";
        programs.biome.enable = true;
        # One configuration for both, rather than treefmt's own default. treefmt
        # names the files itself, and Biome would look for the ignore file next
        # to the copy in the store. Biome checks the configuration as it loads,
        # and treefmt-nix's schema lags behind it.
        programs.biome.validate.enable = false;
        programs.biome.settings = removeAttrs (builtins.fromJSON (builtins.readFile ./biome.json)) ["vcs"];
        programs.alejandra.enable = true;
        programs.rustfmt.enable = true;
        programs.just.enable = true;
        programs.shellcheck.enable = true;
        # direnv reads it, no shell runs it.
        settings.formatter.shellcheck.excludes = [".envrc"];
        programs.shfmt.enable = true;
        # The script has no extension, since it is run as `sh polylogue`.
        settings.formatter.shellcheck.includes = ["*.sh" "polylogue"];
        settings.formatter.shfmt.includes = ["*.sh" "polylogue"];
      });

    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {packages = tools pkgs;};
    });
  };
}
