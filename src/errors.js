// Errors that services throw to signal an expected failure. The central error handler in app.js
// sends err.status with err.message; anything without a status becomes a generic 500.
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new AppError(400, message);
export const notFound = (message) => new AppError(404, message);
