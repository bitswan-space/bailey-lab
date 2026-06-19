// console-data.jsx — intentionally empty.
//
// The console used to ship a large block of mock/seed data here (fake users,
// workspaces, devices, activity, recovery codes, a sample server identity).
// All of that has been removed: the console now renders ONLY live data from
// the Bailey APIs, and shows honest loading/empty/"not available yet" states
// for anything without a backend endpoint. The user must never see mock data.
//
// SC_DATA is published as an empty object purely so any stray legacy reader
// fails loudly (undefined property) rather than silently rendering a seed
// value. The module is kept (and imported by main.jsx) to preserve the
// dependency-ordered load contract; delete the import too once nothing
// references window.SC_DATA.
window.SC_DATA = {};
