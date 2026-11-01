# Linux build/test environment for the vault contract.
# Needed on Windows: near-sandbox has no Windows binary and ABI generation fails with MSVC.
FROM rust:1.93
RUN rustup target add wasm32-unknown-unknown \
 && rustup component add rustfmt clippy \
 && curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
ENV PATH="/root/.cargo/bin:/usr/local/cargo/bin:${PATH}"
WORKDIR /work
