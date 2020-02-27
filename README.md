# ReasonML Mobile

## Requirements

- Docker

There is some additional requirements for Linux look at [docs/linux-setup.md](./docs/linux-setup.md)

## How to try it?

```shell
git clone git@github.com:EduardoRFS/reason-mobile.git
cd reason-mobile
./toolchain.sh
```

Now you should be inside of docker
```
cd /app/hello-reason
esy # the first time can take some time
esy start
```

## iOS

Right know it only works with Android, I want to make it works also on iOS but that's a lot of work
