# Landing page

The public project website is in `site/` and deploys through `.github/workflows/pages.yml` to GitHub Pages.

The walkthrough panel on the home page is intentionally a placeholder. When a recording is ready, add an optimized MP4 at `site/assets/morning-agent-demo.mp4` and a WebVTT caption file at `site/assets/morning-agent-demo.en.vtt`, then replace the `.video-placeholder` block in `site/index.html` with a `<video controls playsinline preload="metadata">` element. Include a poster image and a `<track kind="captions" srclang="en">` element. Keep the video reasonably compressed so it loads well on mobile; do not add analytics or third-party embeds that track visitors.

The download button links to GitHub's source archive for the default branch. It is source code, not a signed macOS installer. Keep that wording clear unless a separately packaged installer is added.
