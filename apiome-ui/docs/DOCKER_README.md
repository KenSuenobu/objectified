# Docker Deployment Guide for Apiome UI

## Quick Start

### Build and Run with Docker

```bash
# Build the Docker image
docker build -t apiome-ui .

# Run the container
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_REST_API_BASE_URL=http://localhost:8000/v1 \
  -e BETTER_AUTH_SECRET=your-secret-here \
  -e ADMIN_PASSWORD=your-admin-password \
  apiome-ui
```

### Using Docker Compose (Recommended)

```bash
# Start the application
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the application
docker-compose down
```

## Environment Variables

Create a `.env` file in the same directory as `docker-compose.yml`:

```env
# REST API Base URL
NEXT_PUBLIC_REST_API_BASE_URL=http://localhost:8000/v1

# NextAuth Configuration
BETTER_AUTH_URL=http://localhost:3000/api/auth
BETTER_AUTH_SECRET=your-secure-secret-here

# GitHub OAuth (Optional)
GITHUB_ID=your-github-client-id
GITHUB_SECRET=your-github-client-secret
GITHUB_TOKEN=your-github-token

# Beta Mode
NEXT_PUBLIC_BETA_MODE=true

# Admin Password
ADMIN_PASSWORD=your-admin-password

# Database Configuration
PGHOST=localhost
PGPORT=5432
PGDATABASE=apiome
PGUSER=postgres
PGPASSWORD=your-database-password
```

## Docker Image Details

### Multi-Stage Build

The Dockerfile uses a multi-stage build process:

1. **deps**: Installs dependencies
2. **builder**: Builds the Next.js application
3. **runner**: Creates the production image

### Image Size Optimization

- Uses `node:20-alpine` base image (small footprint)
- Only copies necessary files to production image
- Excludes dev dependencies
- Uses Next.js standalone output mode

### Security Features

- Runs as non-root user (`nextjs:nodejs`)
- Minimal attack surface (Alpine Linux)
- Only exposes necessary port (3000)

## Building for Different Environments

### Development Build

```bash
docker build --target builder -t apiome-ui:dev .
docker run -p 3000:3000 -v $(pwd):/app apiome-ui:dev npm run dev
```

### Production Build

```bash
docker build -t apiome-ui:latest .
docker run -p 3000:3000 apiome-ui:latest
```

### Build with Custom Tags

```bash
# Build with version tag
docker build -t apiome-ui:1.0.0 .

# Build for specific architecture
docker buildx build --platform linux/amd64,linux/arm64 -t apiome-ui:latest .
```

## Production Deployment

### Using Docker Compose with External Database

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: apiome
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: your-db-password
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - apiome-network

  apiome-ui:
    build: ..
    depends_on:
      - postgres
    environment:
      PGHOST: postgres
      PGPORT: 5432
      PGDATABASE: apiome
      PGUSER: postgres
      PGPASSWORD: your-db-password
      BETTER_AUTH_SECRET: your-secret
      ADMIN_PASSWORD: your-admin-password
    ports:
      - "3000:3000"
    networks:
      - apiome-network

volumes:
  postgres-data:

networks:
  apiome-network:
    driver: bridge
```

### Health Checks

Add health check to docker-compose.yml:

```yaml
services:
  apiome-ui:
    # ... other config
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

## Troubleshooting

### Build Fails - Native Dependencies

If bcrypt or pg fail to build:

```bash
# Ensure build tools are available
docker build --build-arg BUILDKIT_INLINE_CACHE=1 .
```

### Container Exits Immediately

Check logs:
```bash
docker logs apiome-ui
```

Common issues:
- Missing required environment variables
- Database connection failure
- Port already in use

### Permission Errors

Ensure the nextjs user has proper permissions:
```bash
# In Dockerfile, add:
RUN chown -R nextjs:nodejs /app
```

## Performance Optimization

### Use Build Cache

```bash
# Enable BuildKit
export DOCKER_BUILDKIT=1

# Build with cache
docker build --cache-from apiome-ui:latest -t apiome-ui:latest .
```

### Multi-Stage Build Benefits

- Smaller final image (only runtime dependencies)
- Faster deployments
- Better security (no build tools in production)

## Monitoring

### Container Stats

```bash
# View resource usage
docker stats apiome-ui

# View logs
docker logs -f apiome-ui
```

### Integrate with Monitoring Tools

- Prometheus: Expose metrics endpoint
- Grafana: Visualize metrics
- ELK Stack: Centralized logging

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
      
      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      
      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: ./apiome-ui
          push: true
          tags: yourusername/apiome-ui:latest
          cache-from: type=registry,ref=yourusername/apiome-ui:buildcache
          cache-to: type=registry,ref=yourusername/apiome-ui:buildcache,mode=max
```

## Kubernetes Deployment

### Basic Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: apiome-ui
spec:
  replicas: 3
  selector:
    matchLabels:
      app: apiome-ui
  template:
    metadata:
      labels:
        app: apiome-ui
    spec:
      containers:
      - name: apiome-ui
        image: apiome-ui:latest
        ports:
        - containerPort: 3000
        env:
        - name: BETTER_AUTH_SECRET
          valueFrom:
            secretKeyRef:
              name: apiome-secrets
              key: nextauth-secret
---
apiVersion: v1
kind: Service
metadata:
  name: apiome-ui-service
spec:
  selector:
    app: apiome-ui
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: LoadBalancer
```

## Updating the Application

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose up -d --build

# Or with Docker directly
docker build -t apiome-ui:latest .
docker stop apiome-ui
docker rm apiome-ui
docker run -d --name apiome-ui -p 3000:3000 apiome-ui:latest
```

## Clean Up

```bash
# Stop and remove container
docker-compose down

# Remove image
docker rmi apiome-ui

# Remove unused images and containers
docker system prune -a
```

## Best Practices

1. **Use .dockerignore** - Exclude unnecessary files from build context
2. **Multi-stage builds** - Keep final image small
3. **Non-root user** - Run as unprivileged user
4. **Environment variables** - Never hard-code secrets
5. **Health checks** - Monitor container health
6. **Resource limits** - Set memory and CPU limits
7. **Version tags** - Tag images with version numbers
8. **Build cache** - Use layer caching for faster builds

## Support

For issues or questions:
- Check Docker logs: `docker logs apiome-ui`
- Review environment variables
- Ensure database is accessible
- Verify network connectivity

---

**Last Updated**: December 6, 2024
**Docker Version**: 24.0+
**Node Version**: 20.x
**Next.js Version**: 16.0.7

