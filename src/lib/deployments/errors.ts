export class DeploymentConflictError extends Error {
  code = "deployment_in_progress";
  status = 409;

  constructor(message = "A deployment is already pending or active for this environment.") {
    super(message);
  }
}
