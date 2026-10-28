#!/usr/bin/python3
"""Adapt Stitch schema annotations to the OpenAI function schema dialect."""
import json
import subprocess
import sys


def normalize_schema(value):
    if isinstance(value, list):
        return [normalize_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: normalize_schema(item) for key, item in value.items()
            if not ('$ref' in value and key in ('description', 'title'))}


def normalize_message(message):
    result = message.get('result')
    if isinstance(result, dict) and isinstance(result.get('tools'), list):
        for tool in result['tools']:
            if 'inputSchema' in tool:
                tool['inputSchema'] = normalize_schema(tool['inputSchema'])
    return message


if __name__ == '__main__':
    child = subprocess.Popen(['/home/rst010/.local/bin/stitch-mcp'],
                             stdin=sys.stdin, stdout=subprocess.PIPE, stderr=sys.stderr,
                             text=True)
    try:
        for line in child.stdout:
            try:
                print(json.dumps(normalize_message(json.loads(line))), flush=True)
            except json.JSONDecodeError:
                print(line, end='', flush=True)
        raise SystemExit(child.wait())
    finally:
        if child.poll() is None:
            child.terminate()
