# Frontend shim: build the Go proxy, then run it serving the mounted
# static assets. The app source (incl. static/) is mounted at /app at
# runtime; only the shim binary is baked into the image.
FROM golang:1.23-alpine AS build
WORKDIR /build
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -o /frontend .

FROM alpine:3.20
COPY --from=build /frontend /usr/local/bin/frontend
WORKDIR /app
ENV BITSWAN_STATIC_DIR=/app/static PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/frontend"]
