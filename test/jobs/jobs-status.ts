import { expect } from 'chai';
import sinon, { stub } from 'sinon';
import { describe, it, before, after } from 'mocha';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { Job, JobStatus, JobRecord } from 'models/job';
import hookServersStartStop from '../helpers/servers';
import { hookTransaction, hookTransactionFailure } from '../helpers/db';
import { jobStatus, hookJobStatus, jobsEqual, itIncludesRequestUrl } from '../helpers/jobs';
import StubService from '../helpers/stub-service';
import { hookRedirect, hookUrl } from '../helpers/hooks';
import { hookRangesetRequest } from '../helpers/ogc-api-coverages';
import { S3ObjectStore } from '../../app/util/object-store';
import env from '../../app/util/env';

const aJob: JobRecord = {
  username: 'joe',
  requestId: uuid().toString(),
  status: JobStatus.RUNNING,
  message: 'it is running',
  progress: 42,
  links: [
    {
      href: 'http://example.com',
      rel: 'link',
      type: 'text/plain',
      bbox: [-100, -30, -80, 20],
      temporal: {
        start: '1996-10-15T00:05:32.000Z',
        end: '1996-11-15T00:05:32.000Z',
      },
    }],
  request: 'http://example.com/harmony?job=aJob',
  numInputGranules: 58,
};

describe('Individual job status route', function () {
  hookServersStartStop({ skipEarthdataLogin: false });
  hookTransaction();
  before(async function () {
    await new Job(aJob).save(this.trx);
    this.trx.commit();
  });
  const jobID = aJob.requestId;
  describe('For a user who is not logged in', function () {
    before(async function () {
      this.res = await jobStatus(this.frontend, { jobID } as Job).redirects(0);
    });
    it('redirects to Earthdata Login', function () {
      expect(this.res.statusCode).to.equal(303);
      expect(this.res.headers.location).to.include(process.env.OAUTH_HOST);
    });

    it('sets the "redirect" cookie to the originally-requested resource', function () {
      expect(this.res.headers['set-cookie'][0]).to.include(encodeURIComponent(`/jobs/${jobID}`));
    });
  });

  describe('For a logged-in user who owns the job', function () {
    hookJobStatus({ jobID, username: 'joe' });
    it('returns an HTTP success response', function () {
      expect(this.res.statusCode).to.equal(200);
    });

    it('returns a single job record in JSON format', function () {
      const actualJob = new Job(JSON.parse(this.res.text));
      expect(jobsEqual(aJob, actualJob)).to.be.true;
    });

    it('includes a "self" relation on the returned job', function () {
      const job = new Job(JSON.parse(this.res.text));
      const selves = job.getRelatedLinks('self');
      expect(selves.length).to.equal(1);
      expect(selves[0].href).to.match(new RegExp(`${this.res.req.path}$`));
    });
  });

  describe('For a logged-in user who does not own the job', function () {
    hookJobStatus({ jobID, username: 'jill' });
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(404);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony.NotFoundError',
        description: `Error: Unable to find job ${jobID}`,
      });
    });
  });

  describe('For a non-existent job ID', function () {
    const unknownRequest = uuid();
    hookJobStatus({ jobID: unknownRequest, username: 'joe' });
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(404);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony.NotFoundError',
        description: `Error: Unable to find job ${unknownRequest}`,
      });
    });
  });

  describe('For an invalid job ID format', function () {
    hookJobStatus({ jobID: 'not-a-uuid', username: 'joe' });
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(400);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony.RequestValidationError',
        description: 'Error: Invalid format for Job ID \'not-a-uuid\'. Job ID must be a UUID.',
      });
    });
  });

  describe('When the database catches fire', function () {
    hookTransactionFailure();
    describe('for a user that should have jobs', function () {
      hookJobStatus({ jobID, username: 'joe' });
      it('returns an internal server error status code', function () {
        expect(this.res.statusCode).to.equal(500);
      });
      it('includes an error message in JSON format indicating a server error', function () {
        const response = JSON.parse(this.res.text);
        expect(response).to.eql({
          code: 'harmony.ServerError',
          description: 'Error: Internal server error.',
        });
      });
    });
  });

  describe('status updates from non-HTTP backends', function () {
    const collection = 'C1233800302-EEDTEST';
    const variableName = 'red_var';
    const version = '1.0.0';
    describe('when the job has started but not completed', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe1');

        it('returns a status field of "running"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('running');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('The job is being processed');
        });

        it('does not supply a link to the STAC catalog', function () {
          const job = JSON.parse(this.res.text);
          expect(job.stac).to.be.undefined;
        });
      });
    });

    describe('when the job has failed to complete', function () {
      StubService.hook({ params: { error: 'something broke' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe2' });
      before(async function () {
        await this.service.complete();
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe2');

        it('returns a status field of "failed"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('failed');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.eql('something broke');
        });

        it('does not supply a link to the STAC catalog', function () {
          const job = JSON.parse(this.res.text);
          expect(job.stac).to.be.undefined;
        });
      });
    });

    describe('when the job has completed successfully', function () {
      StubService.hook({ params: { status: 'successful', argo: 'true' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe3' });
      before(async function () {
        await this.service.complete();
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe3');

        it('returns a status field of "successful"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('successful');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('The job has completed successfully');
        });
      });
    });

    describe('when the request is limited by maxResults', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName,
        { username: 'jdoe1', query: { maxResults: 2 } });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe1');

        it('returns a human-readable message field indicating the request has been limited to a subset of the granules', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('CMR query identified 177 granules, but the request has been limited to process only the first 2 granules because you requested 2 maxResults.');
        });
      });
    });
  });

  describe('status updates from HTTP backends', function () {
    const collection = 'C1104-PVC_TS2';
    const variableName = 'all';
    const version = '1.0.0';

    describe('when the job has started but not completed', function () {
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe1');

        it('returns a status field of "running"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('running');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('The job is being processed');
        });

        it('does not supply a link to the STAC catalog', function () {
          const job = JSON.parse(this.res.text);
          expect(job.stac).to.be.undefined;
        });
      });
    });

    describe('when the job has failed to complete', function () {
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe2' });
      before(async function () {
        const id = this.res.headers.location.split('/').pop();
        await request(this.frontend)
          .get('/example/status').query({ id, error: 'something broke' });
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe2');

        it('returns a status field of "failed"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('failed');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.eql('something broke');
        });

        it('does not supply a link to the STAC catalog', function () {
          const job = JSON.parse(this.res.text);
          expect(job.stac).to.be.undefined;
        });
      });
    });

    describe('when an incomplete job has provided links as a partial status updates', function () {
      const links = [
        {
          href: 'http://example.com/1',
          title: 'Example 1',
          type: 'text/plain',
          rel: 'data',
        },
        {
          href: 'http://example.com/2',
          title: 'Example 2',
          type: 'text/ornate',
          rel: 'data',
        },
      ];

      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        await this.service.sendResponse({ item: links[0] });
        await this.service.sendResponse({ item: links[1] });
      });
      hookRedirect('jdoe1');

      it('returns the links in its response', function () {
        const job = new Job(JSON.parse(this.res.text));
        const outputLinks = job.getRelatedLinks('data');
        expect(outputLinks).to.eql(links);
      });

      it('maintains a status of "running"', function () {
        const job = JSON.parse(this.res.text);
        expect(job.status).to.equal('running');
      });
    });

    describe('when an incomplete job has provided a percentage progress update', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        await this.service.sendResponse({ progress: 20 });
      });
      hookRedirect('jdoe1');

      it('displays the progress in its response', function () {
        const job = JSON.parse(this.res.text);
        expect(job.progress).to.equal(20);
      });

      it('maintains a status of "running"', function () {
        const job = JSON.parse(this.res.text);
        expect(job.status).to.equal('running');
      });
    });

    describe('when an incomplete job provides an out-of-range percentage', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        this.res = await this.service.sendResponse({ progress: -1 }).ok(() => true);
      });

      it('rejects the update', async function () {
        expect(this.res.status).to.equal(400);
        const body = JSON.parse(this.res.text);
        expect(body.message).to.equal('Job record is invalid: ["Job progress must be between 0 and 100"]');
      });
    });

    describe('when an incomplete job provides a non-numeric percentage', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        this.res = await this.service.sendResponse({ progress: 'garbage' }).ok(() => true);
      });

      it('rejects the update', async function () {
        expect(this.res.status).to.equal(400);
        const body = JSON.parse(this.res.text);
        expect(body.message).to.equal('Job record is invalid: ["Job progress must be between 0 and 100"]');
      });
    });

    describe('when a job has provided an S3 URL as a result', function () {
      const s3Uri = 's3://example-bucket/public/example/path.tif';
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        await this.service.sendResponse({ item: { href: s3Uri } });
      });
      hookRedirect('jdoe1');

      it('provides a permanent link to a Harmony HTTP URL', function () {
        const job = new Job(JSON.parse(this.res.text));
        const jobOutputLinks = job.getRelatedLinks('data');
        expect(jobOutputLinks[0].href).to.match(/^http/);
        expect(jobOutputLinks[0].href).to.have.string('/service-results/example-bucket/public/example/path.tif');
      });

      describe('loading the provided Harmony HTTP URL', function () {
        before(function () {
          sinon.stub(S3ObjectStore.prototype, 'signGetObject')
            .callsFake(async (url, params) => `https://example.com/signed/${params['A-userid']}`);
        });
        after(function () {
          (S3ObjectStore.prototype.signGetObject as sinon.SinonStub).restore();
        });

        hookUrl(function () {
          const job = new Job(JSON.parse(this.res.text));
          return job.getRelatedLinks('data')[0].href.split(/:\d+/)[1];
        }, 'jdoe1');

        it('temporarily redirects to a presigned URL for the data', function () {
          expect(this.res.statusCode).to.equal(307);
          expect(this.res.headers.location).to.equal('https://example.com/signed/jdoe1');
        });
      });
    });

    describe('when a job has provided an S3 URL result with application/x-zarr mime type', function () {
      const s3Uri = 's3://example-bucket/public/example/path.tif';
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        await this.service.sendResponse({ item: { href: s3Uri, type: 'application/x-zarr' } });
      });
      hookRedirect('jdoe1');

      it('returns the S3 URL', function () {
        const job = new Job(JSON.parse(this.res.text));
        const jobOutputLinks = job.getRelatedLinks('data');
        expect(jobOutputLinks[0].href).to.equal(s3Uri);
      });

      it('includes a link to the staging bucket', function () {
        const job = new Job(JSON.parse(this.res.text));
        const bucketLinks = job.getRelatedLinks('s3-access');
        expect(bucketLinks.length).to.equal(1);
        const urlRegex = new RegExp(`^s3://${env.stagingBucket}/public/harmony/stub/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/$`);
        expect(bucketLinks[0].href).to.match(urlRegex);
        expect(bucketLinks[0].title).to.equal('Results in AWS S3. Access from AWS us-west-2 with keys from /cloud-access.sh');
      });

      it('includes a link to the /cloud-access json endpoint', function () {
        const job = new Job(JSON.parse(this.res.text));
        const cloudAccessJsonLinks = job.getRelatedLinks('cloud-access-json');
        expect(cloudAccessJsonLinks.length).to.equal(1);
        expect(cloudAccessJsonLinks[0].href).to.match(/^http.*\/cloud-access$/);
        expect(cloudAccessJsonLinks[0].title).to.equal('Access keys for s3:// URLs, usable from AWS us-west-2 (JSON format)');
        expect(cloudAccessJsonLinks[0].type).to.equal('application/json');
      });

      it('includes a link to the /cloud-access.sh endpoint', function () {
        const job = new Job(JSON.parse(this.res.text));
        const cloudAccessShLinks = job.getRelatedLinks('cloud-access-sh');
        expect(cloudAccessShLinks.length).to.equal(1);
        expect(cloudAccessShLinks[0].href).to.match(/^http.*\/cloud-access.sh$/);
        expect(cloudAccessShLinks[0].title).to.equal('Access keys for s3:// URLs, usable from AWS us-west-2 (Shell format)');
        expect(cloudAccessShLinks[0].type).to.equal('application/x-sh');
      });

      it('includes instructions in the message on how to access the S3 links', function () {
        const job = new Job(JSON.parse(this.res.text));
        expect(job.message).to.contain('Contains results in AWS S3. Access from AWS us-west-2 with keys from');
      });
    });

    describe('when a job has links with temporal and bbox fields', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, { username: 'jdoe1' });
      before(async function () {
        await this.service.sendResponse({
          item: {
            href: 'https://example.com',
            type: 'image/gif',
            bbox: '-10,-10,10,10',
            temporal: '2020-01-01T00:00:00.000Z,2020-01-02T00:00:00.000Z',
          },
        });
      });
      hookRedirect('jdoe1');

      it('includes the temporal range in the link', function () {
        const job = new Job(JSON.parse(this.res.text));
        const link = job.getRelatedLinks('data')[0];
        expect(link.temporal).to.eql({ start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z' });
      });

      it('includes the bbox in the link', function () {
        const job = new Job(JSON.parse(this.res.text));
        const link = job.getRelatedLinks('data')[0];
        expect(link.bbox).to.eql([-10, -10, 10, 10]);
      });
    });

    describe('when the job has completed successfully', function () {
      const query = { subset: ['lat(-80:80)', 'lon(-100:100)'] };
      hookRangesetRequest(version, collection, variableName, { query, username: 'jdoe3' });
      before(async function () {
        const id = this.res.headers.location.split('/').pop();
        await request(this.frontend)
          .get('/example/status').query({ id, status: 'successful', argo: 'true' });
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe3');

        it('returns a status field of "successful"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('successful');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('The job has completed successfully');
        });

        itIncludesRequestUrl('/C1104-PVC_TS2/ogc-api-coverages/1.0.0/collections/all/coverage/rangeset?subset=lat(-80%3A80)&subset=lon(-100%3A100)');
      });
    });

    describe('warning messages', function () {
      describe('when maxResults is not specified and the CMR hits is greater than the max granule limit', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 2);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, collection, variableName, { username: 'jdoe3' });
        hookRedirect('jdoe3');

        it('returns a warning message about system limits', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('CMR query identified 118 granules, but the request has been limited to process only the first 2 granules because of system constraints.');
        });
      });

      describe('when the maxResults and the granule limit are both greater than the CMR hits', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 200);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, collection, variableName, { username: 'jdoe3', query: { maxResults: 200 } });
        hookRedirect('jdoe3');

        it('does not return a warning message', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('The job is being processed');
        });
      });

      describe('when the maxResults is less than the granule limit and less than the CMR hits', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 200);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, collection, variableName, { username: 'jdoe3', query: { maxResults: 30 } });
        hookRedirect('jdoe3');

        it('returns a warning message about maxResults limiting the number of results', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('CMR query identified 118 granules, but the request has been limited to process only the first 30 granules because you requested 30 maxResults.');
        });
      });

      describe('when the maxResults is greater than the CMR hits, but the CMR hits is greater than the system limit', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 30);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, collection, variableName, { username: 'jdoe3', query: { maxResults: 200 } });
        hookRedirect('jdoe3');

        it('returns a warning message about maxResults limiting the number of results', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('CMR query identified 118 granules, but the request has been limited to process only the first 30 granules because of system constraints.');
        });
      });

      describe('when the maxResults is equal to the granule limit, and less than the CMR hits', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 100);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, collection, variableName, { username: 'jdoe3', query: { maxResults: 100 } });
        hookRedirect('jdoe3');

        it('returns a warning message about maxResults limiting the number of results', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('CMR query identified 118 granules, but the request has been limited to process only the first 100 granules because of system constraints.');
        });
      });

      describe('when maxResults, the granule limit, and the CMR hits are all equal', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 118);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, collection, variableName, { username: 'jdoe3', query: { maxResults: 118 } });
        hookRedirect('jdoe3');

        it('does not return a warning message', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('The job is being processed');
        });
      });

      describe('when multiple collections share the same short name', function () {
        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, 'harmony_example', variableName, { username: 'jdoe3' });
        hookRedirect('jdoe3');

        it('returns a warning message about the multiple matching collections', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('There were 2 collections that matched the provided short name. C1234088182-EEDTEST was selected. To use a different collection submit a new request specifying the desired CMR concept ID instead of the collection short name.');
        });
      });

      describe('when multiple collections share the same short name and the granule limit is exceeded', function () {
        before(function () {
          this.glStub = stub(env, 'maxGranuleLimit').get(() => 2);
        });
        after(function () {
          this.glStub.restore();
        });

        StubService.hook({ params: { status: 'successful' } });
        hookRangesetRequest(version, 'harmony_example', variableName, { username: 'jdoe3' });
        hookRedirect('jdoe3');

        it('returns a warning message that includes both warnings', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.equal('There were 2 collections that matched the provided short name. C1234088182-EEDTEST was selected. To use a different collection submit a new request specifying the desired CMR concept ID instead of the collection short name. CMR query identified 176 granules, but the request has been limited to process only the first 2 granules because of system constraints.');
        });
      });
    });
  });
});
