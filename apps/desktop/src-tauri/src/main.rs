// Prevents an extra console window from popping open on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hindsight_lib::run();
}
