#!/bin/sh
set -e

echo "Starting Ziggle Chatbot Backend..."
echo "Migrations will run automatically on startup"

# Start the application (migrations run in DbModule.onModuleInit)
exec bun run start:prod
