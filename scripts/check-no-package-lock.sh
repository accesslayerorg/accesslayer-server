#!/usr/bin/env sh

if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
   echo "package-lock.json is not allowed in this repository. Use pnpm only."
   exit 1
fi

if [ -f package-lock.json ]; then
   echo "package-lock.json is not allowed in this repository. Use pnpm only."
   exit 1
fi
