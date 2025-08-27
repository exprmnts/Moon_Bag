# Deployment Guide for Moon-Bag Bot

## Overview
This is a Node.js Telegram bot application that can be deployed on various platforms.

## Prerequisites
- Node.js 18+ installed
- Environment variables configured (TELEGRAM_BOT_TOKEN, Firebase config, etc.)

## Deployment Options

### 1. Heroku
```bash
# Install Heroku CLI
heroku create your-app-name
git push heroku main
heroku config:set TELEGRAM_BOT_TOKEN=your_token
heroku config:set NODE_ENV=production
```

### 2. Railway
```bash
# Connect your GitHub repo
# Railway will automatically detect and deploy
# Set environment variables in Railway dashboard
```

### 3. Render
```bash
# Connect your GitHub repo
# Build Command: npm run build
# Start Command: npm start
# Set environment variables in Render dashboard
```

### 4. Vercel
```bash
# Install Vercel CLI
npm i -g vercel
vercel --prod
```

### 5. Docker
```bash
# Build image
docker build -t moon-bag-bot .

# Run container
docker run -d --name moon-bot \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e NODE_ENV=production \
  moon-bag-bot
```

### 6. DigitalOcean App Platform
- Connect your GitHub repo
- Build Command: `npm run build`
- Run Command: `npm start`
- Set environment variables

## Environment Variables
Make sure to set these in your hosting platform:
- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token
- Firebase configuration variables
- Any other API keys your bot needs

## Build Process
The build script (`npm run build`) is a no-op for Node.js apps but satisfies platforms that require it.

## Troubleshooting
- Ensure Node.js 18+ is specified in your hosting platform
- Check that all environment variables are set
- Verify the start command is `npm start`
- Check logs for any runtime errors

## Support
If you encounter issues, check the hosting platform's logs and ensure all dependencies are properly installed.
