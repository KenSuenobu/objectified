# Docker Deployment Checklist

## ✅ Pre-Deployment Checklist

### 1. Files Created
- [x] `Dockerfile` exists
- [x] `docker-compose.yml` exists
- [x] `.dockerignore` exists
- [x] `.env.docker` template exists
- [x] `DOCKER_README.md` documentation exists
- [x] `DOCKER_QUICK_REF.md` quick reference exists
- [x] `next.config.ts` updated with standalone output

### 2. Environment Setup
- [ ] Copy `.env.docker` to `.env`
- [ ] Update `BETTER_AUTH_SECRET` (generate random 32 chars)
- [ ] Update `ADMIN_PASSWORD` (secure password)
- [ ] Update `PGPASSWORD` (database password)
- [ ] Set `NEXT_PUBLIC_REST_API_BASE_URL` (API endpoint)
- [ ] Configure database connection (PGHOST, PGPORT, etc.)
- [ ] (Optional) Configure GitHub OAuth credentials

### 3. Prerequisites
- [ ] Docker installed (version 24.0+)
- [ ] Docker Compose installed
- [ ] Sufficient disk space (~2GB for build)
- [ ] Port 3000 available

## 🚀 Deployment Steps

### Step 1: Verify Docker Installation
```bash
docker --version
docker-compose --version
```

### Step 2: Configure Environment
```bash
cd /Users/kenji/Development/apiome/apiome-ui
cp .env.docker .env
nano .env  # or vim, code, etc.
```

### Step 3: Build the Image
```bash
docker-compose build
```

Expected output: Build completes successfully (~3-5 minutes first time)

### Step 4: Start the Container
```bash
docker-compose up -d
```

Expected output: Container starts successfully

### Step 5: Verify Deployment
```bash
# Check container is running
docker-compose ps

# Check logs
docker-compose logs -f

# Test application
curl http://localhost:3000
```

## ✅ Post-Deployment Verification

### 1. Container Health
- [ ] Container is running: `docker-compose ps`
- [ ] No restart loops: `docker-compose ps` shows "Up" status
- [ ] Logs show no errors: `docker-compose logs | grep -i error`

### 2. Application Access
- [ ] Homepage loads: http://localhost:3000
- [ ] Login page works: http://localhost:3000/login
- [ ] Admin portal accessible: http://localhost:3000/admin
- [ ] API responds: http://localhost:3000/api/health (if implemented)

### 3. Authentication
- [ ] Can login with test user
- [ ] NextAuth session works
- [ ] Admin password authentication works

### 4. Database Connection
- [ ] Application connects to database
- [ ] Queries execute successfully
- [ ] No connection errors in logs

### 5. Features Working
- [ ] User management (admin)
- [ ] Tenant management (admin)
- [ ] Signup workflow
- [ ] GitHub OAuth (if configured)

## 🔧 Troubleshooting Checklist

### Build Fails
- [ ] Check Dockerfile syntax
- [ ] Verify package.json exists
- [ ] Check for native module build errors
- [ ] Try: `docker-compose build --no-cache`

### Container Won't Start
- [ ] Check environment variables in .env
- [ ] Verify BETTER_AUTH_SECRET is set
- [ ] Check port 3000 is not in use: `lsof -i :3000`
- [ ] Review logs: `docker-compose logs apiome-ui`

### Application Not Accessible
- [ ] Container is running: `docker ps`
- [ ] Port mapping correct: `docker-compose ps`
- [ ] Firewall not blocking port 3000
- [ ] Try: `curl http://localhost:3000`

### Database Connection Issues
- [ ] Database container running (if using docker-compose)
- [ ] PGHOST, PGPORT, PGDATABASE correct
- [ ] PGUSER and PGPASSWORD correct
- [ ] Network connectivity between containers

### Performance Issues
- [ ] Check resource usage: `docker stats`
- [ ] Review container logs for errors
- [ ] Check database query performance
- [ ] Monitor memory usage

## 📊 Monitoring Checklist

### Daily Monitoring
- [ ] Check container status: `docker-compose ps`
- [ ] Review logs for errors: `docker-compose logs --tail=100`
- [ ] Monitor resource usage: `docker stats apiome-ui`
- [ ] Verify application responsive: `curl http://localhost:3000`

### Weekly Monitoring
- [ ] Review full logs for patterns
- [ ] Check disk usage: `docker system df`
- [ ] Verify backups (if configured)
- [ ] Test disaster recovery procedure

### Monthly Maintenance
- [ ] Update base image: Rebuild with latest node:20-alpine
- [ ] Clean up unused images: `docker system prune -a`
- [ ] Review and update dependencies
- [ ] Performance optimization review

## 🔒 Security Checklist

### Before Production
- [ ] Change all default passwords
- [ ] Use strong BETTER_AUTH_SECRET (32+ characters)
- [ ] Use strong ADMIN_PASSWORD
- [ ] Enable HTTPS/SSL (reverse proxy)
- [ ] Configure firewall rules
- [ ] Set up network security groups
- [ ] Enable Docker Content Trust (if using registry)
- [ ] Scan image for vulnerabilities: `docker scan apiome-ui`

### Ongoing Security
- [ ] Regular security updates
- [ ] Monitor logs for suspicious activity
- [ ] Review access logs
- [ ] Keep base image updated
- [ ] Audit environment variables
- [ ] Rotate secrets regularly

## 🎯 Production Readiness Checklist

### Infrastructure
- [ ] Load balancer configured (if using)
- [ ] SSL/TLS certificates installed
- [ ] DNS configured correctly
- [ ] Backup strategy implemented
- [ ] Monitoring tools integrated (Prometheus, etc.)
- [ ] Log aggregation configured (ELK, etc.)

### Application
- [ ] All environment variables set
- [ ] Database migrations run
- [ ] Admin accounts created
- [ ] Email service configured (if needed)
- [ ] OAuth providers configured
- [ ] Error tracking enabled (Sentry, etc.)

### Testing
- [ ] Load testing completed
- [ ] Security testing passed
- [ ] Integration tests pass
- [ ] User acceptance testing done
- [ ] Performance benchmarks met

### Documentation
- [ ] Deployment guide reviewed
- [ ] Operations runbook created
- [ ] Incident response plan documented
- [ ] Contact information updated

## 🚨 Emergency Procedures

### Quick Restart
```bash
docker-compose restart
```

### Full Reset
```bash
docker-compose down
docker-compose up -d --build
```

### Rollback to Previous Version
```bash
docker-compose down
docker pull apiome-ui:previous-tag
docker-compose up -d
```

### Emergency Stop
```bash
docker-compose down
```

### View Recent Logs
```bash
docker-compose logs --tail=500 apiome-ui
```

## 📝 Sign-Off

### Deployment Team
- [ ] Developer: Reviewed and approved
- [ ] DevOps: Infrastructure ready
- [ ] Security: Security review passed
- [ ] QA: Testing completed
- [ ] Manager: Deployment authorized

### Deployment Date: ________________

### Deployed By: ________________

### Notes:
_________________________________________________
_________________________________________________
_________________________________________________

---

**Last Updated**: December 6, 2024
**Version**: 1.0
**Status**: Ready for Deployment

