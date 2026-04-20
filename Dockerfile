########################################
# Build Stage: Compiles TypeScript app
########################################
FROM node:20 AS builder

# Set working directory inside the container
WORKDIR /app

# Copy package metadata first for better layer caching
COPY package*.json ./

# Install dependencies including dev dependencies for building
RUN npm ci --loglevel=error --no-audit --no-fund

# Copy source files
COPY . .

# Compile TypeScript → JavaScript (output goes to /app/dist)
RUN npm run build

# Keep only production dependencies for runtime image
RUN npm prune --omit=dev --loglevel=error --no-audit --no-fund



########################################
# Final Stage: Lightweight runtime image
########################################
FROM node:20-alpine

# Set working directory
WORKDIR /app

# install ssh-keygen
RUN apk add --no-cache openssh-keygen

# Only copy compiled JS code, package metadata, and production dependencies from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Expose SFTP, FTP control, and WebDAV ports
EXPOSE 22
EXPOSE 21
EXPOSE 1900

# Default command to run transfer servers bootstrap
CMD ["node", "dist/server.js"]
