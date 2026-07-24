#!/bin/bash

# Docker Build and Publish Script for Apiome UI
# This script builds the Docker image and prepares it for publishing to a remote server

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="apiome-ui"
REGISTRY=${DOCKER_REGISTRY:-""}  # Set via environment variable or default to empty
VERSION=${VERSION:-$(date +%Y%m%d-%H%M%S)}
TAG=${TAG:-"latest"}

# Print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if Docker is running
check_docker() {
    print_info "Checking Docker installation..."
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    if ! docker info &> /dev/null; then
        print_error "Docker daemon is not running. Please start Docker."
        exit 1
    fi

    print_success "Docker is running"
}

# Function to check if required files exist
check_files() {
    print_info "Checking required files..."

    local required_files=("Dockerfile" "package.json" "next.config.ts")
    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            print_error "Required file not found: $file"
            exit 1
        fi
    done

    print_success "All required files found"
}

# Function to build the Docker image
build_image() {
    print_info "Building Docker image..."
    print_info "Image: ${IMAGE_NAME}:${TAG}"
    print_info "Version: ${VERSION}"

    # Determine platform to use
    local platform=""

    # Priority: PLATFORM env var > BUILDPLATFORM env var > auto-detect
    if [ -n "$PLATFORM" ]; then
        platform="$PLATFORM"
        print_info "Using PLATFORM environment variable: $platform"
    elif [ -n "$BUILDPLATFORM" ]; then
        platform="$BUILDPLATFORM"
        print_info "Using BUILDPLATFORM environment variable: $platform"
    else
        # Auto-detect platform
        if [[ "$(uname -m)" == "arm64" ]] || [[ "$(uname -m)" == "aarch64" ]]; then
            platform="linux/arm64"
            print_info "Auto-detected ARM64 platform"
        else
            platform="linux/amd64"
            print_info "Auto-detected AMD64 platform"
        fi
    fi

    # Build with multiple tags
    local build_args=(
        "--platform" "$platform"
        "--build-arg" "BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
        "--build-arg" "VERSION=${VERSION}"
        "-t" "${IMAGE_NAME}:${TAG}"
        "-t" "${IMAGE_NAME}:${VERSION}"
    )

    # Add registry prefix if set
    if [ -n "$REGISTRY" ]; then
        build_args+=("-t" "${REGISTRY}/${IMAGE_NAME}:${TAG}")
        build_args+=("-t" "${REGISTRY}/${IMAGE_NAME}:${VERSION}")
    fi

    # Execute build
    docker build --platform linux/amd64 "${build_args[@]}" .

    if [ $? -eq 0 ]; then
        print_success "Docker image built successfully"
    else
        print_error "Docker build failed"
        exit 1
    fi
}

# Function to test the image
test_image() {
    print_info "Testing Docker image..."

    # Start container for testing
    local test_container="apiome-ui-test-$$"
    docker run -d \
        --name "$test_container" \
        -p 3001:3000 \
        -e BETTER_AUTH_SECRET="test-secret-key-for-testing-only" \
        -e ADMIN_PASSWORD="test-password" \
        "${IMAGE_NAME}:${TAG}" > /dev/null

    # Wait for container to start
    sleep 5

    # Test if container is running
    if docker ps | grep -q "$test_container"; then
        print_success "Container started successfully"

        # Test if application responds
        if curl -f http://localhost:3001 &> /dev/null; then
            print_success "Application is responding"
        else
            print_warning "Application not responding on port 3001"
        fi

        # Cleanup test container
        docker stop "$test_container" > /dev/null 2>&1
        docker rm "$test_container" > /dev/null 2>&1
        print_info "Test container cleaned up"
    else
        print_error "Container failed to start"
        docker logs "$test_container" 2>&1 || true
        docker rm -f "$test_container" > /dev/null 2>&1 || true
        exit 1
    fi
}

# Function to get image size
show_image_info() {
    print_info "Image Information:"
    echo ""
    docker images "${IMAGE_NAME}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}" | head -n 5
    echo ""
}

# Function to save image to tar file
save_image() {
    print_info "Saving Docker image to tar file..."

    local output_file="${IMAGE_NAME}-${VERSION}.tar"
    docker save "${IMAGE_NAME}:${TAG}" -o "$output_file"

    if [ -f "$output_file" ]; then
        local size=$(du -h "$output_file" | cut -f1)
        print_success "Image saved to: $output_file (Size: $size)"

        # Compress the tar file
        print_info "Compressing tar file..."
        gzip -f "$output_file"

        if [ -f "${output_file}.gz" ]; then
            local compressed_size=$(du -h "${output_file}.gz" | cut -f1)
            print_success "Compressed image: ${output_file}.gz (Size: $compressed_size)"
        fi
    else
        print_error "Failed to save image"
        exit 1
    fi
}

# Function to push image to registry
push_image() {
    if [ -z "$REGISTRY" ]; then
        print_warning "No registry specified. Skipping push."
        print_info "Set DOCKER_REGISTRY environment variable to enable push."
        return
    fi

    print_info "Pushing image to registry: $REGISTRY"

    # Push both tags
    docker push "${REGISTRY}/${IMAGE_NAME}:${TAG}"
    docker push "${REGISTRY}/${IMAGE_NAME}:${VERSION}"

    if [ $? -eq 0 ]; then
        print_success "Image pushed successfully"
        print_info "Pull with: docker pull ${REGISTRY}/${IMAGE_NAME}:${TAG}"
    else
        print_error "Failed to push image"
        exit 1
    fi
}

# Function to generate deployment script
generate_deployment_script() {
    print_info "Generating deployment script..."

    local deploy_script="deploy-${VERSION}.sh"

    cat > "$deploy_script" << 'EOF'
#!/bin/bash

# Deployment script for Apiome UI
# Generated automatically - customize as needed

set -e

IMAGE_NAME="apiome-ui"
VERSION="VERSION_PLACEHOLDER"
TAG="TAG_PLACEHOLDER"
REGISTRY="REGISTRY_PLACEHOLDER"

echo "Deploying Apiome UI..."
echo "Version: $VERSION"

# Load image if tar file exists
if [ -f "${IMAGE_NAME}-${VERSION}.tar.gz" ]; then
    echo "Loading image from tar file..."
    gunzip -c "${IMAGE_NAME}-${VERSION}.tar.gz" | docker load
elif [ -n "$REGISTRY" ]; then
    echo "Pulling image from registry..."
    docker pull "${REGISTRY}/${IMAGE_NAME}:${TAG}"
else
    echo "Using local image..."
fi

# Stop and remove existing container
echo "Stopping existing container..."
docker stop apiome-ui 2>/dev/null || true
docker rm apiome-ui 2>/dev/null || true

# Start new container
echo "Starting new container..."
docker run -d \
    --name apiome-ui \
    --restart unless-stopped \
    -p 3000:3000 \
    --env-file .env \
    "${IMAGE_NAME}:${TAG}"

echo "Deployment complete!"
echo "Application available at: http://localhost:3000"

# Show logs
echo ""
echo "Container logs:"
docker logs --tail 50 apiome-ui
EOF

    # Replace placeholders
    sed -i.bak "s/VERSION_PLACEHOLDER/${VERSION}/g" "$deploy_script"
    sed -i.bak "s/TAG_PLACEHOLDER/${TAG}/g" "$deploy_script"
    sed -i.bak "s/REGISTRY_PLACEHOLDER/${REGISTRY}/g" "$deploy_script"
    rm "${deploy_script}.bak" 2>/dev/null || true

    chmod +x "$deploy_script"
    print_success "Deployment script created: $deploy_script"
}

# Function to generate docker-compose for remote deployment
generate_compose_file() {
    print_info "Generating deployment docker-compose.yml..."

    local compose_file="docker-compose.deploy-${VERSION}.yml"

    cat > "$compose_file" << EOF
version: '3.8'

services:
  apiome-ui:
    image: ${REGISTRY:+${REGISTRY}/}${IMAGE_NAME}:${TAG}
    container_name: apiome-ui
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_REST_API_BASE_URL=\${NEXT_PUBLIC_REST_API_BASE_URL}
      - NEXT_PUBLIC_BROWSE_URL=\${NEXT_PUBLIC_BROWSE_URL}
      - BETTER_AUTH_URL=\${BETTER_AUTH_URL}
      - BETTER_AUTH_SECRET=\${BETTER_AUTH_SECRET}
      - GITHUB_ID=\${GITHUB_ID}
      - GITHUB_SECRET=\${GITHUB_SECRET}
      - GITHUB_TOKEN=\${GITHUB_TOKEN}
      - NEXT_PUBLIC_BETA_MODE=\${NEXT_PUBLIC_BETA_MODE}
      - ADMIN_PASSWORD=\${ADMIN_PASSWORD}
      - PGHOST=\${PGHOST}
      - PGPORT=\${PGPORT}
      - PGDATABASE=\${PGDATABASE}
      - PGUSER=\${PGUSER}
      - PGPASSWORD=\${PGPASSWORD}
    networks:
      - apiome-network
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

networks:
  apiome-network:
    driver: bridge
EOF

    print_success "Deployment compose file created: $compose_file"
}

# Function to create deployment package
create_deployment_package() {
    print_info "Creating deployment package..."

    local package_dir="apiome-ui-deploy-${VERSION}"
    local package_file="${package_dir}.tar.gz"

    # Create package directory
    mkdir -p "$package_dir"

    # Copy necessary files
    cp ".env.docker" "${package_dir}/.env.template"
    cp "docker-compose.deploy-${VERSION}.yml" "${package_dir}/docker-compose.yml"
    cp "deploy-${VERSION}.sh" "${package_dir}/deploy.sh"

    # Copy compressed image if it exists
    if [ -f "${IMAGE_NAME}-${VERSION}.tar.gz" ]; then
        cp "${IMAGE_NAME}-${VERSION}.tar.gz" "$package_dir/"
    fi

    # Create README
    cat > "${package_dir}/README.md" << EOF
# Apiome UI Deployment Package

Version: ${VERSION}
Build Date: $(date)

## Quick Deployment

1. Copy \`.env.template\` to \`.env\` and configure:
   \`\`\`bash
   cp .env.template .env
   nano .env  # Edit with your values
   \`\`\`

2. Run deployment script:
   \`\`\`bash
   ./deploy.sh
   \`\`\`

Or use docker-compose:
   \`\`\`bash
   docker-compose up -d
   \`\`\`

## Access

- Application: http://localhost:3000
- Admin Portal: http://localhost:3000/admin

## Support

Check logs: \`docker logs apiome-ui\`
Stop: \`docker stop apiome-ui\`
Restart: \`docker restart apiome-ui\`
EOF

    # Create tarball
    tar czf "$package_file" "$package_dir"

    if [ -f "$package_file" ]; then
        local size=$(du -h "$package_file" | cut -f1)
        print_success "Deployment package created: $package_file (Size: $size)"

        # Cleanup
        rm -rf "$package_dir"
    else
        print_error "Failed to create deployment package"
        exit 1
    fi
}

# Function to show usage
show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Options:
  --tag TAG           Set image tag (default: latest)
  --version VERSION   Set version (default: timestamp)
  --registry REGISTRY Set Docker registry
  --no-test          Skip image testing
  --no-save          Skip saving to tar file
  --push             Push to registry
  --package          Create deployment package
  --help             Show this help message

Environment Variables:
  DOCKER_REGISTRY    Docker registry URL
  VERSION            Image version
  TAG                Image tag

Examples:
  # Build with default settings
  $0

  # Build and push to registry
  DOCKER_REGISTRY=myregistry.com $0 --push

  # Build with custom tag and create package
  $0 --tag v1.0.0 --package

  # Build and skip testing
  $0 --no-test
EOF
}

# Main execution
main() {
    print_info "=== Apiome UI Docker Build Script ==="
    echo ""

    # Parse command line arguments
    local skip_test=false
    local skip_save=false
    local do_push=false
    local do_package=false

    while [[ $# -gt 0 ]]; do
        case $1 in
            --tag)
                TAG="$2"
                shift 2
                ;;
            --version)
                VERSION="$2"
                shift 2
                ;;
            --registry)
                REGISTRY="$2"
                shift 2
                ;;
            --no-test)
                skip_test=true
                shift
                ;;
            --no-save)
                skip_save=true
                shift
                ;;
            --push)
                do_push=true
                shift
                ;;
            --package)
                do_package=true
                shift
                ;;
            --help)
                show_usage
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done

    # Execute build steps
    check_docker
    check_files
    build_image
    show_image_info

    if [ "$skip_test" = false ]; then
        test_image
    else
        print_warning "Skipping image testing"
    fi

    if [ "$skip_save" = false ]; then
        save_image
    else
        print_warning "Skipping image save"
    fi

    if [ "$do_push" = true ]; then
        push_image
    fi

    # Always generate deployment files
    generate_deployment_script
    generate_compose_file

    if [ "$do_package" = true ]; then
        create_deployment_package
    fi

    # Summary
    echo ""
    print_success "=== Build Complete ==="
    echo ""
    print_info "Image: ${IMAGE_NAME}:${TAG}"
    print_info "Version: ${VERSION}"
    [ -n "$REGISTRY" ] && print_info "Registry: ${REGISTRY}"
    echo ""
    print_info "Next Steps:"
    echo "  1. Test locally: docker run -p 3000:3000 ${IMAGE_NAME}:${TAG}"
    echo "  2. Deploy with: ./deploy-${VERSION}.sh"
    echo "  3. Or use: docker-compose -f docker-compose.deploy-${VERSION}.yml up -d"
    [ "$do_package" = true ] && echo "  4. Transfer: apiome-ui-deploy-${VERSION}.tar.gz to remote server"
    echo ""
}

# Run main function
main "$@"

