FROM alpine:3.11.7

ENV GOPATH /go

COPY . /go/src/github.com/alan-eu/hound

RUN apk update \
	&& apk add go git subversion libc-dev mercurial bzr openssh tini \
	&& cd /go/src/github.com/alan-eu/hound \
	&& go mod download \
	&& go install github.com/alan-eu/hound/cmds/houndd \
	&& apk del go \
	&& rm -f /var/cache/apk/* \
	&& rm -rf /go/src /go/pkg

VOLUME ["/data"]

EXPOSE 6080

ENTRYPOINT ["/sbin/tini", "--", "/go/bin/houndd", "-conf", "/data/config.json"]
