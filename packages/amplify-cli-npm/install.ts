#!/usr/bin/env node

import { install } from '.';

install().catch(err => {
  throw err;
});
