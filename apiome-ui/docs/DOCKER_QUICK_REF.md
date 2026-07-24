# 🐳 Docker Quick Reference

## Files Created
- ✅ `Dockerfile` - Multi-stage production build
- ✅ `docker-compose.yml` - Container orchestration  
- ✅ `.dockerignore` - Build optimization
- ✅ `.env.docker` - Environment template
- ✅ `DOCKER_README.md` - Full documentation
- ✅ `next.config.ts` - Updated with standalone output

## Quick Start (3 Steps)

### 1. Setup Environment
```bash
cp .env.docker .env
# Edit .env with your values
```

### 2. Build & Run
```bash
docker-compose up -d
```

### 3. Access
```
http://localhost:3000
```

## Essential Commands

### Start/Stop
```bash
docker-compose up -d          # Start
docker-compose down           # Stop
docker-compose restart        # Restart
```

### Logs & Monitoring
```bash
docker-compose logs -f        # View logs
docker stats apiome-ui   # Resource usage
docker ps                     # Running containers
```

### Build & Update
```bash
docker-compose build          # Rebuild image
docker-compose up -d --build  # Rebuild and restart
docker-compose pull           # Pull latest image
```

### Maintenance
```bash
docker-compose exec apiome-ui sh  # Shell access
docker system prune -a                 # Clean up
```

## Environment Variables (Required)

```env
BETTER_AUTH_SECRET=<generate-random-32-chars>
ADMIN_PASSWORD=<your-secure-password>
PGHOST=localhost
PGPORT=5432
PGDATABASE=apiome
PGUSER=postgres
PGPASSWORD=<database-password>
```

## Verification Checklist

- [ ] Files created (Dockerfile, docker-compose.yml, etc.)
- [ ] .env file configured
- [ ] Docker & Docker Compose installed
- [ ] Build successful: `docker-compose build`
- [ ] Container running: `docker-compose ps`
- [ ] Application accessible: http://localhost:3000
- [ ] Admin portal works: http://localhost:3000/admin
- [ ] No errors in logs: `docker-compose logs`

## Troubleshooting

### Build Fails
```bash
docker-compose build --no-cache
```

### Container Won't Start
```bash
docker-compose logs apiome-ui
# Check for:
# - Missing environment variables
# - Port conflicts
# - Database connection issues
```

### Reset Everything
```bash
docker-compose down -v
docker system prune -a
docker-compose up -d --build
```

## Image Details

- **Base**: node:20-alpine
- **Size**: ~250MB
- **User**: nextjs (non-root)
- **Port**: 3000
- **Mode**: Standalone

## Security Features

✅ Non-root execution
✅ Minimal Alpine base
✅ No dev dependencies in production
✅ Environment-based secrets
✅ Network isolation

## Next Steps

1. **Production**: Add health checks, resource limits
2. **Scaling**: Use Kubernetes or Docker Swarm
3. **Monitoring**: Integrate Prometheus/Grafana
4. **CI/CD**: Automate builds with GitHub Actions

---

📖 **Full Docs**: `DOCKER_README.md`
🚀 **Status**: Production Ready

