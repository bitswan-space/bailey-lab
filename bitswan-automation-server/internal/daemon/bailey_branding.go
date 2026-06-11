package daemon

// Shared branding bits for every Bailey-served HTML page (denied page,
// share pages, and — in later stages — the management UI). Kept in one
// place so the pages stay visually consistent with the AOC theme.

// bitswanLogoSVG is the BitSwan logo sized for page headers.
const bitswanLogoSVG = `<svg width="140" height="33" viewBox="0 0 663.4 154.8" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M612.6,77.7c5.8-5.8,12.4-8.7,19.8-8.7c6.1,0,10.8,1,14,3s4.3,3.7,4.3,7.3v38h12.6V78.6c0-5.6-1.8-9.8-5.4-12.9c-5.6-4.7-13.2-7.1-22.7-7.1c-8.6,0-16.2,3.3-22.7,9.9v-8.6H600v57.5h12.6V77.7z M583.2,117.3V59.8h-12.6V68c-7-6-15.8-9.4-25-9.5c-9,0-16.7,2.6-23,7.9c-3.5,3.1-5.4,7.3-5.4,12.9v18.5c0,5.6,1.8,9.8,5.4,12.9c6.1,5.2,13.8,7.8,23,7.8c9.2,0.2,18.2-3.2,25-9.4v8.1L583.2,117.3z M570.6,98.4c-2.7,3.2-6.2,5.6-10.1,7c-3.8,1.8-8,2.8-12.2,2.9c-4.8,0-9.6-1.3-13.8-3.7c-3.5-2-4.7-3.8-4.7-7.4V80.1c0-3.8,1.1-5.5,4.7-7.4c4.2-2.4,8.9-3.6,13.8-3.6c4.2,0.1,8.4,1,12.2,2.7c4.5,1.8,7.8,4.1,10.1,7V98.4z M491.7,117.3l18.1-57.5h-13.1l-14.2,47.3h-3l-15-47.3h-13.4l-16.3,47.3H432l-13.9-47.3h-13.6l18.2,57.5H443l14.5-42.9l14,42.9H491.7z M360.5,118.4c12.2,0,21.1-1.2,26.5-3.6c6.4-3,9.6-7.6,9.6-13.6v-6.1c0.2-3.8-1.4-7.5-4.2-10c-2.6-2.4-7.2-4.6-14-6.3l-20.1-5.4c-5.6-1.4-9.2-2.8-10.6-4s-2.4-3.3-2.4-6c0-2.9,1-4.9,3-6.2c2.6-1.7,8.4-2.6,17.1-2.6c9.1-0.1,18.1,0.8,27,2.7V46.8c-8.5-1.6-17-2.4-25.6-2.3c-12.7,0-21.8,1.7-27.1,5.3c-4.7,3.1-7,7.1-7,12v5.3c-0.1,3.6,1.3,7,3.9,9.5c3.1,2.9,8.4,5.4,16,7.3l19.2,5.2c9.3,2.3,12.1,4.5,12.1,9.5c0,3.6-1.1,6-3.3,7.2c-3.3,1.7-9.8,2.6-19.4,2.6c-9.5,0.1-18.9-0.9-28.2-2.7v10.7C341.9,117.8,351.1,118.5,360.5,118.4 M323.3,106.7c-4.6,1.3-9.3,1.9-14.1,1.8c-4.7,0-8.4-0.9-11-2.9c-2.4-1.8-3.1-4-3.1-8.6V69.6h28.2v-9.9h-28.1V45.1h-12.6v52.8c0,7.8,1.4,12,5.8,15.7c4.2,3.3,10.6,4.9,19.4,4.9c6.8,0,11.9-0.7,15.6-2.2L323.3,106.7z M266,59.7h-12.6v57.5H266V59.7z M266,36.5h-12.6v13.1H266V36.5z M213,117.3c11.8,0,18-1.3,22.7-5.3c4.5-3.8,6.1-6.5,6.1-12.4v-5c0-6-2.9-10.3-8.7-12.9c-0.9-0.5-1.6-0.8-1.9-0.9l0.4-0.2c5.4-2.2,8-6.3,8-12.4V63c0-5.5-1.4-8.5-5.1-11.8c-4.4-3.7-11.8-5.5-22.4-5.5h-36.3v71.6H213z M215.2,85.9c5,0,8.6,0.8,10.8,2.5s3.3,4.5,3.3,8.4s-1.3,6.5-3.7,8.2c-2.2,1.6-6.3,2.4-12.3,2.4h-25.1V85.9H215.2z M211.2,55.7c6.8,0,11.1,0.9,13.3,2.9c1.7,1.7,2.6,4.2,2.6,7.7c0,3.7-0.9,6.2-2.8,7.7c-2.1,1.5-5,2.3-8.9,2.3h-27.2V55.7H211.2z" fill="#0D1326"/><path d="M0,104.5V5l59.9,50L10.3,92.8C6,96,2.5,100,0,104.5z M90.7,80.6l-21.3,18c-7.1,6.2-10.9,14.5-10.9,24c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5s16.7-3.4,22.8-9.5c6.1-6.1,9.4-14.2,9.4-22.8s-3.3-16.7-9.4-22.7L90.7,80.6z M118.5,15.8l-25,19.5l0,0L13.1,96.6C4.9,102.6,0,112.3,0,122.5c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5h40.4c-2.9-1.6-5.6-3.7-8.1-6.1c-7-7-10.8-16.3-10.8-26.1c0-10.7,4.4-20.5,12.5-27.6l46-38.7c6.8-5.8,10.8-14.9,10.8-24C123,26.4,121.5,20.8,118.5,15.8z M57.5,0l36.1,29.3L115.7,12c-0.5-0.6-1.3-1.5-2.3-2.7C107,1.6,97.5,0,90.8,0H57.5z" fill="#0D1326"/></svg>`

// bitswanPageCSS is the shared stylesheet for full-page Bailey HTML.
// Always interpolated as a value (never as a Printf format string), so
// percent signs are written singly.
const bitswanPageCSS = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 40px 20px; color: #18181B; background: #FAFAFA; }
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid #E4E4E7; }
.header h1 { font-size: 20px; font-weight: 600; color: #18181B; margin: 0; flex: 1; }
.sign-out { font-size: 13px; color: #71717A; text-decoration: none; padding: 6px 12px; border: 1px solid #E4E4E7; border-radius: 6px; }
.sign-out:hover { background: #F5F5F6; color: #18181B; }
.card { background: #fff; border: 1px solid #E4E4E7; border-radius: 8px; padding: 24px; margin: 16px 0; }
.card h2 { font-size: 16px; font-weight: 600; margin: 0 0 8px 0; color: #18181B; }
.card p { margin: 8px 0; color: #3F3F46; font-size: 14px; line-height: 1.5; }
button, .btn { background: #093DF5; color: #FAFAFA; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; display: inline-block; text-decoration: none; }
button:hover, .btn:hover { background: #0731C4; }
input[type=text] { width: 100%; padding: 10px 12px; margin: 8px 0; border: 1px solid #D1D5DB; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
input[type=text]:focus { outline: none; border-color: #093DF5; box-shadow: 0 0 0 2px rgba(9,61,245,0.15); }
.note { color: #71717A; font-size: 13px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #E4E4E7; font-size: 14px; }
th { background: #F5F5F6; font-weight: 600; color: #18181B; }
code { background: #F5F5F6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
`
