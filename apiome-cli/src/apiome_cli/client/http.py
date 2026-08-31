"""Synchronous HTTP client for apiome-rest."""

from __future__ import annotations

import httpx

from apiome_cli.client.errors import exit_on_api_error, exit_on_connection_error
from apiome_cli.config import API_KEY_HEADER, SESSION_AUTH_HEADER, CliSettings

DEFAULT_TIMEOUT = 30.0


class RestClient:
    """Thin httpx wrapper using CLI settings for the service base URL.

    Parameters
    ----------
    settings:
        Resolved CLI settings supplying ``base_url`` and optional ``api_key``.
    timeout:
        HTTP connect + read timeout in seconds (default ``DEFAULT_TIMEOUT``).
        Import operations should use a longer value such as 120 s.
    verify:
        Whether to verify TLS certificates (default ``True``).  Pass
        ``verify=False`` only for local development with self-signed certs
        (corresponds to the ``--insecure`` root flag).
    anonymous:
        When ``True`` no ``X-API-Key`` header is sent even if ``settings``
        contains an API key.  Use this for unauthenticated endpoints such as
        ``GET /health``.
    session:
        When ``True`` send ``Authorization: Bearer <session_token>`` from
        settings and omit ``X-API-Key``.  Use for ``/auth/...`` routes.
    """

    def __init__(
        self,
        settings: CliSettings,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        verify: bool = True,
        anonymous: bool = False,
        session: bool = False,
    ) -> None:
        self._base_url = settings.base_url_str
        self._timeout = timeout
        self._verify = verify
        if anonymous:
            self._headers: dict[str, str] = {}
        elif session:
            self._headers = _session_headers(settings)
        else:
            self._headers = _auth_headers(settings)

    def get(self, path: str) -> httpx.Response:
        """Issue GET ``path`` relative to ``base_url`` and exit on HTTP error.

        Parameters
        ----------
        path:
            URL path starting with ``/`` (e.g. ``/health``).

        Returns
        -------
        httpx.Response
            The successful response; raises ``SystemExit`` on HTTP or transport error.
        """
        response = self.get_raw(path)
        exit_on_api_error(response)
        return response

    def get_raw(
        self,
        path: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Issue GET ``path`` and return the response without exiting on HTTP errors.

        Parameters
        ----------
        path:
            URL path starting with ``/`` (e.g. ``/types/by-slug/email``).
        headers:
            Optional request headers merged with default auth headers.

        Returns
        -------
        httpx.Response
            The HTTP response; transport errors still exit the CLI.
        """
        url = f"{self._base_url}{path}"
        merged_headers = {**self._headers, **(headers or {})}
        try:
            with httpx.Client(timeout=self._timeout, verify=self._verify) as client:
                return client.get(url, headers=merged_headers)
        except httpx.RequestError as exc:
            exit_on_connection_error(exc)

    def post(
        self,
        path: str,
        *,
        json: object = None,
        content: bytes | None = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Issue POST ``path`` relative to ``base_url`` and exit on HTTP error.

        Parameters
        ----------
        path:
            URL path starting with ``/``.
        json:
            Optional JSON-serialisable payload; sets ``Content-Type: application/json``.
        content:
            Optional raw bytes body (mutually exclusive with ``json``).
        data:
            Optional multipart form fields.
        files:
            Optional multipart file parts as ``{field: (filename, content, content_type)}``.
        headers:
            Additional request headers merged with default auth headers.

        Returns
        -------
        httpx.Response
            The successful response; raises ``SystemExit`` on HTTP or transport error.
        """
        url = f"{self._base_url}{path}"
        merged_headers = {**self._headers, **(headers or {})}
        try:
            with httpx.Client(timeout=self._timeout, verify=self._verify) as client:
                response = client.post(
                    url,
                    json=json,
                    content=content,
                    data=data,
                    files=files,
                    headers=merged_headers,
                )
        except httpx.RequestError as exc:
            exit_on_connection_error(exc)
        exit_on_api_error(response)
        return response

    def post_raw(
        self,
        path: str,
        *,
        json: object = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Issue POST ``path`` and return the response without exiting on HTTP errors.

        Like :meth:`post`, but the caller inspects the status (e.g. to retry on a
        recoverable gate). Transport errors still exit the CLI.

        Parameters
        ----------
        path:
            URL path starting with ``/``.
        json:
            Optional JSON-serialisable payload; sets ``Content-Type: application/json``.
        headers:
            Additional request headers merged with default auth headers.

        Returns
        -------
        httpx.Response
            The HTTP response; transport errors still exit the CLI.
        """
        url = f"{self._base_url}{path}"
        merged_headers = {**self._headers, **(headers or {})}
        try:
            with httpx.Client(timeout=self._timeout, verify=self._verify) as client:
                return client.post(url, json=json, headers=merged_headers)
        except httpx.RequestError as exc:
            exit_on_connection_error(exc)

    def put(self, path: str, *, json: object = None) -> httpx.Response:
        """Issue PUT ``path`` relative to ``base_url`` and exit on HTTP error.

        Parameters
        ----------
        path:
            URL path starting with ``/``.
        json:
            Optional JSON-serialisable payload; sets ``Content-Type: application/json``.

        Returns
        -------
        httpx.Response
            The successful response; raises ``SystemExit`` on HTTP or transport error.
        """
        response = self.put_raw(path, json=json)
        exit_on_api_error(response)
        return response

    def put_raw(self, path: str, *, json: object = None) -> httpx.Response:
        """Issue PUT ``path`` and return the response without exiting on HTTP errors.

        For callers that render a rejection themselves rather than take the shared mapping — a
        422 whose error list belongs against a local file's own paths, for instance.

        Parameters
        ----------
        path:
            URL path starting with ``/``.
        json:
            Optional JSON-serialisable payload; sets ``Content-Type: application/json``.

        Returns
        -------
        httpx.Response
            The HTTP response; transport errors still exit the CLI.
        """
        url = f"{self._base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout, verify=self._verify) as client:
                return client.put(url, json=json, headers=self._headers)
        except httpx.RequestError as exc:
            exit_on_connection_error(exc)

    def delete(self, path: str) -> httpx.Response:
        """Issue DELETE ``path`` relative to ``base_url`` and exit on HTTP error.

        Parameters
        ----------
        path:
            URL path starting with ``/``.

        Returns
        -------
        httpx.Response
            The successful response; raises ``SystemExit`` on HTTP or transport error.
        """
        url = f"{self._base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout, verify=self._verify) as client:
                response = client.delete(url, headers=self._headers)
        except httpx.RequestError as exc:
            exit_on_connection_error(exc)
        exit_on_api_error(response)
        return response


def _auth_headers(settings: CliSettings) -> dict[str, str]:
    """Build default request headers (``X-API-Key`` when configured).

    Parameters
    ----------
    settings:
        Resolved CLI settings.

    Returns
    -------
    dict[str, str]
        Header dict with ``X-API-Key`` set when an API key is present.
    """
    api_key = settings.api_key_value()
    if api_key:
        return {API_KEY_HEADER: api_key}
    return {}


def _session_headers(settings: CliSettings) -> dict[str, str]:
    """Build bearer session headers for ``/auth/...`` routes.

    Parameters
    ----------
    settings:
        Resolved CLI settings.

    Returns
    -------
    dict[str, str]
        Header dict with ``Authorization: Bearer …`` when a session token is set.
    """
    token = settings.session_token_value()
    if token:
        return {SESSION_AUTH_HEADER: f"Bearer {token}"}
    return {}
