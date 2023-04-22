#!/usr/bin/env bash
#
# Build script

yarn install

( cd objectified-data ; yarn build ; cd .. )
( cd objectified-services ; yarn build ; cd .. )

