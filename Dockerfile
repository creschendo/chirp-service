# Builds the chirp-service container image.
# TODO: pick a Node base image, install production dependencies, copy src/ and migrations/,
# TODO: run as a non-root user, expose port 4000, and start the server with node (not npm) so SIGTERM reaches the process.
