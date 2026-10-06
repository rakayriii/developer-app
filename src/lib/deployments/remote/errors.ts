// Remote deployment error types, in a leaf module so the pure command, env-file, and diagnostics
// helpers can use them without pulling in the database or SSH stack.

/** A value could not be turned into a valid remote command argument. */
export class RemoteCommandError extends Error {
  code = "remote_capability_error";
  status = 400;
}

/** A remote deployment precondition failed, or a remote Docker operation was rejected. */
export class RemoteDeploymentError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "RemoteDeploymentError";
    this.code = code;
    this.status = status;
  }
}
