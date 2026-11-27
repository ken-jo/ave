# Linux shell filter

The filter is applied inside the Linux shell container before the requested
command is executed. It blocks creation of Unix and vsock sockets, nested user
and mount namespaces, mount changes, and io_uring. Unix socket pairs and
ordinary thread creation remain available.

Build with the checked-in Rust toolchain and the target standard libraries.
The linker and musl startup objects are supplied by the toolchain.

Build each binary natively on a Linux host of the same architecture: x64 on
`x86_64-unknown-linux-gnu`, arm64 on `aarch64-unknown-linux-gnu`. These are the
hosts CI's two Linux shell container jobs run on, and they are the canonical
builders. A cross-build does not reproduce the pin. Cargo hashes `rustc -vV`,
including its `host:` line, into every crate's `-C metadata`. Different
metadata changes the symbol hashes and therefore the code layout. Source paths
and `CARGO_HOME` do not matter once they are remapped as below.

```sh
export RUSTFLAGS="-C linker=rust-lld -C linker-flavor=ld.lld -C link-self-contained=yes --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$(pwd)=/src/ave"
cargo build --manifest-path native/linux-shell-seccomp/Cargo.toml --locked --offline --release \
  --target "$(uname -m)-unknown-linux-musl"
```

The build inputs are pinned by `Cargo.lock` and `rust-toolchain.toml`. Compare
each binary's SHA-256 with `src/permissions/mxc-linux-seccomp-pins.json` before
installing it in the matching directory under `resources/linux-shell-seccomp`.
