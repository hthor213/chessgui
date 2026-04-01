#!/usr/bin/env python3
"""Take a screenshot of the running app for documentation."""
import subprocess
import sys

def main():
    subprocess.run(["screencapture", "-w", "screenshot.png"], check=True)
    print("Saved screenshot.png")

if __name__ == "__main__":
    main()
