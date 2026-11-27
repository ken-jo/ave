# Linux shell filter

The filter is applied inside the Linux shell container before the requested
command is executed. It blocks creation of Unix and vsock sockets, nested user
and mount namespaces, mount changes, and io_uring. Unix socket pairs and
ordinary thread creation remain available.

Build with the checked-in Rust toolchain and the target standard libraries.
The linker and musl startup objects are supplied by the toolchain.

```sh
export RUSTFLAGS="-C linker=rust-lld -C linker-flavor=ld.lld -C link-self-contained=yes --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$(pwd)=/src/ave"
cargo build --manifest-path native/linux-shell-seccomp/Cargo.toml --locked --offline --release \
  --target aarch64-unknown-linux-musl --target x86_64-unknown-linux-musl
```

The build inputs are pinned by `Cargo.lock` and `rust-toolchain.toml`. Compare
each binary's SHA-256 with `src/permissions/mxc-linux-seccomp-pins.json` before
installing it in the matching directory under `resources/linux-shell-seccomp`.
