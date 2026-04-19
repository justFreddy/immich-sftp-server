########################################
# Build Stage: Compiles TypeScript app
########################################
FROM node:20 AS builder

# Set working directory inside the container
WORKDIR /app

# Copy all files (you can fine-tune with a .dockerignore)
COPY . .

# Install all dependencies, including dev (for TypeScript, etc.)
RUN npm install

# Compile TypeScript → JavaScript (output goes to /app/dist)
RUN npm run build



########################################
# Final Stage: Lightweight runtime image
########################################
FROM node:20-alpine

# Set working directory
WORKDIR /app

# install ssh-keygen
RUN apk add --no-cache openssh-keygen

# Only copy compiled JS code and necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install only production dependencies to keep image small
RUN npm install --omit=dev

# Expose SFTP and FTP control ports
EXPOSE 22
EXPOSE 21

# Default command to run transfer servers bootstrap
CMD ["node", "dist/server.js"]
