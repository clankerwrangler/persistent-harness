// Only an executable or explicit bootstrap runtime rejection permits repair.
export class PythonRuntimeRejection extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PythonRuntimeRejection";
  }
}
