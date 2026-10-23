#!/usr/bin/env python3
"""Run as WSL root only after approval; provisions dedicated project databases."""
import pathlib
import secrets
import subprocess
import pwd
import os
root = pathlib.Path(__file__).resolve().parent.parent
owner = pwd.getpwuid(root.stat().st_uid)
if os.geteuid() != 0 or owner.pw_uid == 0:
    raise SystemExit('Run as root against a project directory owned by its non-root developer')
targets = [('dev', '.env.example', '.env'), ('test', '.env.test.example', '.env.test')]
for suffix, _, config_file in targets:
    name = 'mail_platform_' + suffix
    query = ("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '%s';"
             "SELECT User FROM mysql.user WHERE User = '%s';") % (name, name)
    exists = subprocess.check_output(['mariadb', '-N', '-e', query], text=True)
    if exists.strip() or (root / config_file).exists():
        raise SystemExit('Refusing to replace existing database, account or environment: ' + name)
for suffix, sample, config_file in targets:
    name = 'mail_platform_' + suffix
    password = secrets.token_hex(24)
    sql = ("CREATE DATABASE %s CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
           "CREATE USER '%s'@'127.0.0.1' IDENTIFIED BY '%s';"
           "GRANT ALL PRIVILEGES ON %s.* TO '%s'@'127.0.0.1';") % (name, name, password, name, name)
    subprocess.run(['mariadb'], input=sql, text=True, check=True)
    envfile = root / config_file
    content = (root / sample).read_text().replace('replace-with-project-password', password).replace('replace-with-test-password', password)
    descriptor = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(content)
    os.chown(envfile, owner.pw_uid, owner.pw_gid)
    print('Created dedicated database and local config: ' + name)
