/** Reconstruct only the last explicit positive numeric CLI cap, never NODE_OPTIONS. */
export function explicitHeapCap(execArgv = process.execArgv) {
  return execArgv.findLast(argument => /^--max-old-space-size=[1-9][0-9]*$/.test(argument));
}
