// The prebuilt ONNX Runtime library calls the compiler runtime's macOS version check
// (`__isPlatformVersionAtLeast`), which rustc does not link by default.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(out) = std::process::Command::new("xcrun")
        .args(["clang", "-print-resource-dir"])
        .output()
    else {
        return;
    };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let lib_dir = std::path::Path::new(&dir).join("lib/darwin");
    if lib_dir.join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
