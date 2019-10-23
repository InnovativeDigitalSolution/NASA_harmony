# Adapting New Services to Harmony

**IMPORTANT! This documentation concerns features under active development.  Additional methods of service integration are currently being implemented and existing ones refined.  Please reach out in #harmony for the latest, for particular adaptation needs, and especially with any feedback that can help us improve.**

In order to connect a new service to Harmony:

1. The service must be exposed in a way that Harmony can invoke it
2. The service must be able to accept requests produced by Harmony
3. The service must send results back to Harmony
4. A new entry in [services.yml](../config/services.yml) must supply information about the service
5. The service should follow Harmony's recommendations for service implementations

A simple reference service, [harmony-gdal](https://git.earthdata.nasa.gov/projects/HARMONY/repos/harmony-gdal/browse), provides examples of each. The remainder of this document describes how to fulfill these requirements in more depth.

## 1. Allowing Harmony to invoke services

At present, Harmony only provides one way of packaging a service for invocation: Docker container images.

### Docker Container Images

The service and all necessary code and dependencies to allow it to run can be packaged in a Docker container image.  Docker images can be staged anywhere Harmony can reach them, e.g. Dockerhub or AWS ECR.  Harmony will run the Docker image, passing the following command-line parameters:

`--harmony-action <action> --harmony-input <input>`

`<action>` is the action Harmony wants the service to perform, currently only `invoke`, which requests that the service be run.  This may be expanded in the future for additional actions such as capability discovery.

`<input>` is a JSON string containing the details of the service operation to be run.  See the latest [Harmony data-operation schema](../app/schemas/) for format details.

The `Dockerfile` in the harmony-gdal project serves as a minimal example of how to set up Docker to accept these inputs using the `ENTRYPOINT` declaration.  Harmony plans to offer a Python library to assist in command line and JSON parsing and validation.

In addition to the defined command-line parameters, Harmony can provide the Docker container with environment variables as set in [services.yml](../config/services.yml) by setting `service.type.params.env` key/value pairs.  See the existing services.yml for examples.

### Future: HTTP

When a backend service has the need, Harmony plans to allow invocations of backends over HTTP, likely by POSTing a Harmony request to an endpoint.  Please contact the team if your service may be a near-term candidate.

## 2. Accepting Harmony requests

When invoking a service, Harmony provides an input detailing the specific operations the service should perform and the URLs of the data it should perform the operations on.  Each new service will need to adapt this message into an actual service invocation, typically transforming the JSON input into method calls, command-line invocations, or HTTP requests.  See the latest [Harmony data-operation schema](../app/schemas/) for details on Harmony's JSON input format.

Ideally, this adaptation would consist only of necessary complexity peculiar to the service in question.  Please let the team know if there are components that can make this process easier and consider sending a pull request or publishing your code if you believe it can help future services.

## 3. Sending results to Harmony

Once complete, a service must send an HTTP POST request to the URL provided in the `callback` field of the Harmony input.  Failing to do so will cause user requests to hang until a timeout that is likely long in order to accommodate large, synchronous operations.  Please be mindful of this and provide ample error handling.

The following are the options for how to call back to the Harmony URL:

`${operation.callback}/response?redirect=<url>` If data has been staged at an accessible location, for instance by pre-signing an S3 URL, the URL can be provided in the "redirect" query parameter and Harmony will issue an HTTP redirect to the staged data.  This is the preferred callback method if there is not substantial performance to be gained by streaming data to the user.  For best compatibility, ensure the `Content-Type` header will be sent by the staging URL.

`${operation.callback}/response?error=<message>` If an error occurs, it can be provided in the "message" query parameter and Harmony will convey it to the user in a format suitable for the protocol.

`${operation.callback}/response` If no query parameters are provided and a POST body is present, Harmony will stream the POST body directly to the user as it receives data, conveying the appropriate `Content-Type` and `Content-Size` headers set in the callback.  Use this method if the service builds its response incrementally and the user would benefit from a partial response while waiting on the remainder.

## 4. Registering services in services.yml

Add an entry to [services.yml](../config/services.yml) and send a pull request to the Harmony team, or ask a Harmony team member for assistance.  The structure of an entry is as follows:

```yaml
- name: harmony/example # A unique identifier string for the service, conventionally <team>/<service>
  type:                 # Configuration for service invocation
    name: docker        # The type of service invocation, currently only "docker"
    params:             # Parameters specific to the service invocation type
      image: harmony/example  # The Docker container image to run
      env:                    # Environment variables to pass to the image
        EDL_USERNAME: !Env ${EDL_USERNAME}  # Note the syntax for reading environment variables from Harmony itself
        EDL_PASSWORD: !Env ${EDL_PASSWORD}  # to avoid placing secrets in git.  Ask the team for assistance if you need this
  collections:           # A list of CMR collection IDs that the service works on
    - C1234-EXAMPLE
  capabilities:          # Service capabilities
    subsetting:
      bbox: true         # Can subset by spatial bounding box
      variable: true     # Can subset by UMM-Var variable
      multiple_variable: true  # Can subset multiple variables at once
    output_formats:      # A list of output mime types the service can produce
      - image/tiff
      - image/png
      - image/gif
    projection_to_proj4: true  # The service can project to Proj4 and EPSG codes
```

This format is under active development.  In the long-term a large portion of it is likely to be editable and discoverable through the CMR via UMM-S.

## 5. Recommendations for service implementations

Note that several of the following are under active discussion and we encourage participation in that discussion

In order to improve user experience, metrics gathering, and to allow compatibility with future development, Harmony strongly encourages service implementations to do the following:

1. Provide provenance information in output files in a manner appropriate to the file format and following EOSDIS guidelines.  Typically this would consist of a list of commands that were run by the service as well as key software versions.
2. Preserve existing file metadata where appropriate.  This includes file-level metadata that has not changed, layer metadata, and particularly provenance metadata that may have been generated by prior transformations.
3. Log request callback URLs, which serve as unique identifiers, as well as Earthdata Login usernames when available to aid in tracing requests and debugging.
4. Proactively protect (non-Docker) service endpoints from high request volume or computational requirements by using autoscaling with maximum thresholds, queueing, and other methods to avoid outages or non-responsiveness.