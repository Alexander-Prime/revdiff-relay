{
  description = "revdiff-relay";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
    claude.url = "github:sadjow/claude-code-nix";
    # Not in nixpkgs; upstream ships its own flake.
    revdiff.url = "github:umputun/revdiff";
  };

  outputs = { self, nixpkgs, flake-utils, claude, revdiff }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        claudePkgs = claude.packages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            # Tracks Claude Code releases ahead of the system channel — this
            # plugin targets features that land before nixpkgs picks them up.
            claudePkgs.default

            # The TUI this plugin drives. Needed here to exercise the plugin
            # against the real thing, not only to review this repo's own diffs.
            revdiff.packages.${system}.default

            pkgs.shellcheck
            # Type-checks hooks/ against the declarations Claude Code writes
            # into .claude-plugin/types/ when it loads the plugin.
            pkgs.typescript
          ];
        };
      }
    );
}
