<!-- fdae755b-389e-4620-942c-56b003d94a01 9eb4a405-691c-41c0-bcee-379ac5418062 -->
# Fix Blank Page Issue

## Root Cause

The JavaScript files are marked as `type="module"` in HTML, which causes them to load asynchronously in an isolated scope. However, the scripts immediately try to access `window.__TAURI__` at the top level (lines 5-6 in both manager.js and bubble.js), before Tauri's API has been injected, causing script execution to fail and resulting in blank pages.

## Solution

1. **Remove type="module" from manager.html** - Change the script tags from:
   ```html
   <script type="module" src="warehouse.js"></script>
   <script type="module" src="manager.js"></script>
   ```


to:

   ```html
   <script src="warehouse.js"></script>
   <script src="manager.js"></script>
   ```

2. **Remove type="module" from bubble.html** - Change the script tag from:
   ```html
   <script type="module" src="bubble.js"></script>
   ```


to:

   ```html
   <script src="bubble.js"></script>
   ```

3. **Test the application** - Run `npm run dev` to verify pages load correctly and display data

## Expected Result

- Manager interface loads with all UI elements visible
- Price data fetches successfully from API and displays in the "实时金价" section
- All navigation tabs work properly
- Bubble window displays price information

### To-dos

- [ ] Add HTTP allowlist configuration to tauri.conf.json
- [ ] Restart development server to apply changes