#!/bin/bash
# setup-schedule.sh - Adds Docker startup/shutdown cron jobs to macOS

DIR=$(pwd)

# Current crontab
crontab -l > mycron 2>/dev/null

# Remove old jobs if they exist
grep -v "docker compose down" mycron | grep -v "docker compose up -d" > mycron_clean

# Add new jobs (these check if TESTING_MODE=false before executing)
echo "0 1 * * * cd $DIR && grep -q \"TESTING_MODE=false\" .env && /usr/local/bin/docker compose down" >> mycron_clean
echo "0 7 * * * cd $DIR && grep -q \"TESTING_MODE=false\" .env && /usr/local/bin/docker compose up -d" >> mycron_clean

# Install new cron file
crontab mycron_clean
rm mycron mycron_clean

echo "✅ Cron schedule successfully installed with TESTING_MODE awareness!"
echo "Containers will SHUT DOWN at 1:00 AM (only if TESTING_MODE=false)."
echo "Containers will START UP at 7:00 AM (only if TESTING_MODE=false)."
echo "Run 'crontab -l' to view your active schedule."
