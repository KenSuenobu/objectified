# YouTube Link Feature

## Overview
Added links to the Apiome YouTube channel (https://www.youtube.com/@apiomedev/) so users can easily access video tutorials and content about the platform.

## Implementation Details

### Locations
The YouTube link appears in two locations:

1. **Home Page Hero Section** - Prominent button in the welcome banner
   - Positioned alongside the "Login / Sign Up" button
   - Labeled as "Watch Tutorials" with a YouTube icon
   - Highly visible in the gradient banner at the top of the home page

2. **Footer** - Text link in the footer navigation
   - Positioned as the first link in the footer links section
   - Labeled as "Tutorials" with a YouTube icon
   - Consistent with other footer links styling

### User Experience
- **Icon**: Uses the official YouTube logo/icon SVG
- **Accessibility**: Includes proper `aria-label` and `title` attributes
- **Target**: Opens in a new tab/window (`target="_blank"`)
- **Security**: Includes `rel="noopener noreferrer"` for security
- **Styling**: Matches the design system with proper hover states and dark mode support

### Technical Changes

#### Files Modified
1. `src/app/HomeClient.tsx` - Added YouTube button in hero section
2. `src/app/components/ClientLayout.tsx` - Added Tutorials link in footer

#### Home Page Changes
- Added "Watch Tutorials" button in the hero action bar
- Uses inline YouTube SVG icon (official YouTube logo path)
- Styled to match the banner design with transparent white background
- Opens in new tab for better user experience

#### Footer Changes
- Added "Tutorials" link as the first item in the footer links
- Includes YouTube icon next to the text
- Maintains consistent styling with other footer links
- Opens in new tab for better user experience

## Benefits
- **Easy Discovery**: Users can quickly find video tutorials and content
- **Brand Awareness**: Promotes the Apiome YouTube channel
- **Better Onboarding**: Video tutorials help new users learn the platform
- **Consistent UX**: Link appears in expected locations (navbar and footer)
- **Accessibility**: Properly labeled for screen readers and keyboard navigation

## Link Details
- **URL**: https://www.youtube.com/@apiomedev/
- **Target Audience**: Users looking for video tutorials, demos, and platform updates
- **Opens In**: New tab/window to preserve user's current session

## Testing
To test the feature:
1. Navigate to the browse app home page
2. Locate the "Watch Tutorials" button in the gradient banner
3. Click the button and verify it opens the YouTube channel in a new tab
4. Scroll to the footer
5. Click the "Tutorials" link and verify it also opens the YouTube channel
6. Test both light and dark mode to ensure proper styling
7. Test hover states on both links

