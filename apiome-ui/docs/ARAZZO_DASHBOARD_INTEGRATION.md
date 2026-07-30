# Arazzo Spec Viewing from Published Dashboard

## Overview

Added the ability to view and download Arazzo workflow specifications directly from the Published Versions dashboard in the Apiome UI.

**Date Implemented:** December 7, 2024  
**Location:** `/ade/dashboard/published`

---

## What Was Added

### New Actions in Published Dashboard

The "Actions" dropdown for each published version now includes two new Arazzo-related options:

1. **View Arazzo (JSON)** - Opens the Arazzo workflow specification in JSON format in a new tab
2. **Download Arazzo (YAML)** - Downloads the Arazzo workflow specification as a YAML file

### Updated Actions Dropdown

The complete actions menu now includes:

| Action | Icon | Description |
|--------|------|-------------|
| Open URL | 🔗 | Opens the OpenAPI schema endpoint |
| Open Swagger UI | 📄 | Opens the interactive Swagger UI documentation |
| **View Arazzo (JSON)** | 🟠 | **Opens Arazzo workflows in JSON format** |
| **Download Arazzo (YAML)** | 🔵 | **Downloads Arazzo workflows as YAML file** |
| Copy OpenAPI URL | 📋 | Copies the OpenAPI schema URL to clipboard |
| Make Public/Private | 🔒/🌍 | Toggles version visibility |

---

## Implementation Details

### New Helper Functions

#### `getArazzoUrl(version: PublishedVersion): string`
Constructs the Arazzo workflow URL from version information.

```typescript
const getArazzoUrl = (version: PublishedVersion): string => {
  const restApiBaseUrl = process.env.NEXT_PUBLIC_REST_API_BASE_URL || 'http://localhost:8000/v1';
  return `${restApiBaseUrl}/arazzo/${version.tenant_slug}/${version.project_slug}/${version.version_id}`;
};
```

#### `handleOpenArazzo(version: PublishedVersion): void`
Opens the Arazzo JSON specification in a new browser tab.

```typescript
const handleOpenArazzo = (version: PublishedVersion) => {
  const arazzoUrl = getArazzoUrl(version);
  window.open(arazzoUrl, '_blank');
};
```

#### `handleOpenArazzoYaml(version: PublishedVersion): Promise<void>`
Fetches the Arazzo specification in YAML format and triggers a download.

```typescript
const handleOpenArazzoYaml = async (version: PublishedVersion) => {
  const arazzoUrl = getArazzoUrl(version);
  try {
    // Fetch with Accept: application/yaml header
    const response = await fetch(arazzoUrl, {
      headers: { 'Accept': 'application/yaml' }
    });
    const yamlContent = await response.text();
    
    // Create blob and download
    const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${version.project_slug}-${version.version_id}-workflows.yaml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    // Error handling with alert dialog
  }
};
```

### Updated Action Handler

The dropdown's change handler now includes cases for the new Arazzo actions:

```typescript
const handleChange = async (value: string) => {
  try {
    switch (value) {
      case 'open':
        handleOpenUrl(version);
        break;
      case 'openSwagger':
        handleOpenSwagger(version);
        break;
      case 'openArazzo':           // NEW
        handleOpenArazzo(version);
        break;
      case 'downloadArazzoYaml':    // NEW
        await handleOpenArazzoYaml(version);
        break;
      case 'copy':
        await handleCopyUrl(version);
        break;
      case 'toggleVisibility':
        await handleToggleVisibility(version);
        break;
    }
  } finally {
    setAction('');
  }
};
```

---

## User Experience

### Viewing Arazzo JSON

1. Navigate to **Published Versions** page
2. Find the version you want to view
3. Click the **Actions** dropdown
4. Select **View Arazzo (JSON)**
5. A new tab opens showing the Arazzo workflow specification in JSON format

**What You See:**
```json
{
  "arazzo": "1.0.1",
  "info": {
    "title": "project-name Workflows",
    "version": "1.0.0"
  },
  "sourceDescriptions": [...],
  "workflows": [...]
}
```

### Downloading Arazzo YAML

1. Navigate to **Published Versions** page
2. Find the version you want to download
3. Click the **Actions** dropdown
4. Select **Download Arazzo (YAML)**
5. Browser downloads a YAML file named: `{project-slug}-{version-id}-workflows.yaml`

**Downloaded File:**
```yaml
arazzo: 1.0.1
info:
  title: project-name Workflows
  version: 1.0.0
sourceDescriptions:
  - name: openapi-source
    type: openapi
    url: /v1/schema/tenant/project/version
workflows:
  - workflowId: userWorkflow
    summary: User CRUD Workflow
    steps: [...]
```

---

## Technical Notes

### Content Negotiation

The YAML download uses HTTP content negotiation:
- Sets `Accept: application/yaml` header
- REST API responds with YAML format
- Client receives text content and creates a download

### File Naming Convention

Downloaded YAML files follow the pattern:
```
{project-slug}-{version-id}-workflows.yaml
```

Examples:
- `user-api-1.0.0-workflows.yaml`
- `payment-system-2.1.0-workflows.yaml`

### Error Handling

If the YAML download fails:
- Error is logged to console
- Alert dialog shows: "Failed to download Arazzo YAML specification"
- User can retry the action

### Browser Compatibility

Both actions work in all modern browsers:
- **View Arazzo (JSON)**: Uses `window.open()` - universally supported
- **Download YAML**: Uses Blob API - supported in all modern browsers

---

## URL Structure

### Arazzo JSON URL
```
{REST_API_BASE_URL}/arazzo/{tenant-slug}/{project-slug}/{version-slug}
```

Example:
```
http://localhost:8000/v1/arazzo/acme/user-api/1.0.0
```

### Arazzo YAML URL
Same URL as JSON, but with different Accept header:
```
GET http://localhost:8000/v1/arazzo/acme/user-api/1.0.0
Accept: application/yaml
```

---

## Configuration

### Environment Variable

The base URL is configurable via environment variable:

```env
NEXT_PUBLIC_REST_API_BASE_URL=http://localhost:8000/v1
```

**Default:** `http://localhost:8000/v1`

**Production Example:**
```env
NEXT_PUBLIC_REST_API_BASE_URL=https://api.apiome.dev/v1
```

---

## Comparison with Existing Features

| Feature | OpenAPI | Arazzo |
|---------|---------|--------|
| View in browser | ✅ Open URL | ✅ View Arazzo (JSON) |
| Interactive docs | ✅ Swagger UI | ❌ Not applicable |
| Copy URL | ✅ | ❌ (coming soon?) |
| Download YAML | ⚠️ Manual | ✅ Download Arazzo (YAML) |
| Download JSON | ⚠️ Manual | ✅ Right-click, Save As |

---

## Future Enhancements

### Potential Additions

1. **Copy Arazzo URL** - Add clipboard copy for Arazzo endpoint
2. **View Single Class Arazzo** - Link to class-specific workflows
3. **Arazzo Visualization** - Visual workflow diagram viewer
4. **Arazzo Editor** - In-app workflow editor
5. **Export Options** - Multiple format options (JSON, YAML, both)
6. **Workflow Execution** - Run workflows directly from UI
7. **Workflow Templates** - Library of common workflow patterns

### Integration Opportunities

- **Testing Tools** - Direct integration with API testing frameworks
- **CI/CD** - Export workflows for automated testing
- **Documentation** - Embed workflows in generated docs
- **Code Generation** - Generate test code from workflows

---

## Testing

### Manual Testing Steps

1. **View JSON:**
   - Go to Published Versions
   - Select any published version
   - Choose "View Arazzo (JSON)" from Actions
   - Verify new tab opens with JSON content
   - Verify URL format is correct

2. **Download YAML:**
   - Go to Published Versions
   - Select any published version
   - Choose "Download Arazzo (YAML)" from Actions
   - Verify file downloads
   - Verify filename format
   - Open file and verify YAML content

3. **Error Handling:**
   - Disconnect from network
   - Try to download YAML
   - Verify error message displays

### Expected Results

✅ JSON view opens in new tab  
✅ YAML downloads with correct filename  
✅ Content matches API response  
✅ Error handling works correctly  
✅ Both work for public and private versions  

---

## Files Modified

```
/src/app/ade/dashboard/published/page.tsx
  - Added getArazzoUrl() helper function
  - Added handleOpenArazzo() handler
  - Added handleOpenArazzoYaml() handler
  - Updated action switch statement
  - Added two new MenuItem components
  - Updated renderValue labels
```

---

## Benefits

### For Developers
- ✅ Quick access to workflow specifications
- ✅ Easy download for offline use
- ✅ Integrates with existing workflow

### For Teams
- ✅ Consistent access patterns
- ✅ Easy sharing of workflows
- ✅ Version-controlled workflow specs

### For API Consumers
- ✅ Self-service access
- ✅ Multiple format options
- ✅ Direct integration capabilities

---

## Related Documentation

- [Arazzo Endpoints Documentation](../../../apiome-rest/docs/ARAZZO_ENDPOINTS.md)
- [Arazzo Quick Reference](../../../apiome-rest/docs/ARAZZO_QUICK_REFERENCE.md)
- [Arazzo Implementation Summary](../../../apiome-rest/docs/ARAZZO_IMPLEMENTATION.md)

---

**Status:** ✅ Complete  
**Last Updated:** December 7, 2024  
**Version:** 1.0.0

