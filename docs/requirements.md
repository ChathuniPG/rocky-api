# R.O.C.K.Y. - Software Requirements Specification

**Project:** TikTok-Style Social Media Platform (Full-Stack Assessment)

| **Version** | **Date**    | **Author**        | **Status** |
|-------------|-------------|-------------------|------------|
| 0.1         | 04 Nov 2026 | Chathuni Gunasena | Draft      |
| 0.2         | 05 Nov 2026 | Chathuni Gunasena | NFR-MNT-01 updated: oxlint replaces ESLint as the linter (see ADR-010)      |
| 0.3         | 07 Nov 2026 | Chathuni Gunasena | Added FR-FEED-09, FR-FEED-10, FR-POST-07 (TikTok-style video autoplay, feed and post layout)      |
| 0.4         | 07 Nov 2026 | Chathuni Gunasena | FR-FEED-09 refined: TikTok-style custom video controls.      |
| 0.5         | 08 Nov 2026 | Chathuni Gunasena | Added FR-MSG-06 (unread messages badge in navigation).      |
| 0.6         | 08 Nov 2026 | Chathuni Gunasena | FR-FEED-10 refined: previous/next feed controls replace the scrollbar.      |

## 1. Introduction

### 1.1 Purpose

This document defines the functional and non-functional requirements for a full-stack, TikTok-style social media web platform built as a technical assessment. It is the single source of truth for scope and acceptance criteria.

### 1.2 Scope

The system consists of a Next.js web application (frontend) and a NestJS REST API (backend). The backend is the only component that communicates with PostgreSQL (application data) and Firebase (Authentication and Storage). Both applications are deployed on AWS EC2 and accessible through a single public URL.

### 1.3 Definitions

- **Feed:** a paginated list of posts shown on the Home page.

- **Post:** user-created content consisting of a caption and one media item (image or short video clip).

- **ID Token:** a short-lived Firebase-issued token proving a user’s identity, sent with each API request.

- **MoSCoW:** prioritization scheme (Must / Should / Could / Won’t).

## 2. Overall Description

### 2.1 User Classes

- **Guest:** unauthenticated visitor; can only access Login and Sign Up.

- **Authenticated User:** can use all features and can modify only their own content.

### 2.2 Constraints

- **C-01:** Frontend must use Next.js (App Router) with TypeScript, Tailwind CSS, and a component library (shadcn/ui).

- **C-02:** Backend must use NestJS with TypeScript, organized into Modules, Controllers, and Services.

- **C-03:** PostgreSQL must be accessed through an ORM (Prisma).

- **C-04:** Firebase must be accessed only through the Firebase Admin SDK or Firebase REST APIs from the backend. The frontend never calls Firebase or PostgreSQL directly.

- **C-05:** Frontend and backend must be maintained in two separate Git repositories.

- **C-06:** Both applications must be deployed on AWS EC2 behind Nginx, managed by PM2.

- **C-07:** Delivery deadline is three days from project start.

### 2.3 Assumptions

- **A-01:** Target devices are laptops and desktops, per the brief. Mobile layouts are a bonus, not a requirement.

- **A-02:** Each post contains exactly one media item.

- **A-03:** Video playback uses the browser’s native `<video>` element with custom controls; no transcoding or streaming infrastructure.

- **A-04:** Users authenticate with email and password only.

## 3. Functional Requirements

### 3.1 Authentication

| **ID**     | **Requirement**                                                                                                                                                                                             | **Priority** |
|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------|
| FR-AUTH-01 | A guest can sign up with email, password, username, and display name.                                                                                                                                       | Must         |
| FR-AUTH-02 | Sign-up validates input: valid email format; password minimum 8 characters with at least one letter and one number; username 3–30 characters (lowercase letters, numbers, underscores, periods) and unique. | Must         |
| FR-AUTH-03 | A registered user can log in with email and password.                                                                                                                                                       | Must         |
| FR-AUTH-04 | The system shows clear error messages for invalid credentials, existing email, taken username, weak password, and network failure.                                                                          | Must         |
| FR-AUTH-05 | Forms show a loading state while a request is in progress and prevent duplicate submission.                                                                                                                 | Must         |
| FR-AUTH-06 | A logged-in user can log out, which clears the session token on the client and revokes it on the server.                                                                                                    | Must         |
| FR-AUTH-07 | Unauthenticated users who visit protected pages are redirected to Login.                                                                                                                                    | Must         |
| FR-AUTH-08 | Expired ID tokens are refreshed automatically without forcing re-login.                                                                                                                                     | Should       |

### 3.2 Home Feed

| **ID**     | **Requirement**                                                                                             | **Priority** |
|------------|-------------------------------------------------------------------------------------------------------------|--------------|
| FR-FEED-01 | The Home page displays a paginated feed of posts, newest first.                                             | Must         |
| FR-FEED-02 | Each post shows the author’s avatar, username, caption, media, like count, and comment count.               | Must         |
| FR-FEED-03 | A user can like and unlike a post; the count updates immediately (optimistic UI) and rolls back on failure. | Must         |
| FR-FEED-04 | A user can save and unsave a post.                                                                          | Must         |
| FR-FEED-05 | A user can share a post by copying its link, with a confirmation toast.                                     | Must         |
| FR-FEED-06 | A user can view a post’s comments, add a comment, and delete their own comments.                            | Must         |
| FR-FEED-07 | More posts load automatically as the user scrolls (infinite scroll).                                        | Should       |
| FR-FEED-08 | A user can manually refresh the feed.                                                                       | Could        |
| FR-FEED-09 | Videos play automatically and loop when mostly visible, and pause when scrolled away or the tab is hidden; only one video plays at a time. Custom controls: click the video to play or pause, mute and volume in the top-left corner, and a thin seekable progress bar. The sound preference persists for the session. Users with reduced motion enabled are not autoplayed. All controls work from the keyboard and are labelled for screen readers.                                                                       | Should        |
| FR-FEED-10 | The feed shows one post per screen with vertical snap scrolling. On wide screens, actions (like, comment, save, share) appear in a vertical column beside the media, with the author’s avatar at the top; the username and caption are overlaid on the media. On wide screens, the feed shows no scrollbar; previous/next controls (and the Up/Down arrow keys) move one post at a time.                                                                       | Should        |

### 3.3 Posts

| **ID**     | **Requirement**                                                                                                                 | **Priority** |
|------------|---------------------------------------------------------------------------------------------------------------------------------|--------------|
| FR-POST-01 | A user can create a post with a caption (max 2,200 characters) and one media file uploaded via the backend to Firebase Storage. | Must         |
| FR-POST-02 | Uploads accept JPEG, PNG, WebP (max 5 MB) and MP4/WebM (max 25 MB); other types or sizes are rejected with a clear message.     | Must         |
| FR-POST-03 | Upload progress or a loading state is shown during upload.                                                                      | Must         |
| FR-POST-04 | A user can edit the caption of their own post.                                                                                  | Must         |
| FR-POST-05 | A user can delete their own post, after a confirmation dialog.                                                                  | Must         |
| FR-POST-06 | Each post has its own page (/posts/\[id\]) so shared links work.                                                                | Should       |
| FR-POST-07 | The post page shows the media and comments side by side on wide screens (comments on the right) and stacked on narrow screens. A back control and the Escape key return to the previous page with its scroll position, or to Home when the page was opened directly.                                                                | Should       |

### 3.4 Search

| **ID**     | **Requirement**                                                                                     | **Priority** |
|------------|-----------------------------------------------------------------------------------------------------|--------------|
| FR-SRCH-01 | A user can search other users by username or display name, using case-insensitive partial matching. | Must         |
| FR-SRCH-02 | Search runs automatically as the user types, debounced to avoid excessive requests.                 | Must         |
| FR-SRCH-03 | A user can filter results (e.g., All users / People I follow).                                      | Must         |
| FR-SRCH-04 | Selecting a result navigates to that user’s profile.                                                | Must         |

### 3.5 Profile

| **ID**     | **Requirement**                                                                                              | **Priority** |
|------------|--------------------------------------------------------------------------------------------------------------|--------------|
| FR-PROF-01 | A profile page displays avatar, display name, username, bio, and counts for posts, followers, and following. | Must         |
| FR-PROF-02 | A profile has a Posts tab showing the user’s posts in a grid.                                                | Must         |
| FR-PROF-03 | A profile has a Saved tab, visible only to the profile owner.                                                | Must         |
| FR-PROF-04 | A user can edit their own display name, bio, and avatar (uploaded via the backend).                          | Must         |
| FR-PROF-05 | A user can follow and unfollow other users.                                                                  | Should       |
| FR-PROF-06 | A user can start a conversation from another user’s profile.                                                 | Should       |

### 3.6 Notifications

| **ID**     | **Requirement**                                                                                                                                      | **Priority** |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------|--------------|
| FR-NOTF-01 | The system creates a notification when someone likes or comments on the user’s post, or follows them. Users are never notified of their own actions. | Must         |
| FR-NOTF-02 | The Notifications page lists notifications newest first, visually distinguishing unread ones.                                                        | Must         |
| FR-NOTF-03 | A user can mark a single notification as read, or mark all as read.                                                                                  | Must         |
| FR-NOTF-04 | The navigation shows an unread notification count badge.                                                                                             | Should       |

### 3.7 Messages

| **ID**    | **Requirement**                                                                                                   | **Priority** |
|-----------|-------------------------------------------------------------------------------------------------------------------|--------------|
| FR-MSG-01 | The Messages page lists the user’s conversations with the other participant, last message preview, and timestamp. | Must         |
| FR-MSG-02 | A user can open a conversation and view its messages in chronological order.                                      | Must         |
| FR-MSG-03 | A user can send text messages (max 1,000 characters).                                                             | Must         |
| FR-MSG-04 | New incoming messages appear without a full page reload (short-interval polling).                                 | Should       |
| FR-MSG-05 | Unread conversations are visually indicated.                                                                      | Should       |
| FR-MSG-06 | The navigation shows the number of conversations with unread messages, updated periodically and immediately after reading a conversation.                                                                      | Should       |

### 3.8 Settings

| **ID**    | **Requirement**                                                                                                                             | **Priority** |
|-----------|---------------------------------------------------------------------------------------------------------------------------------------------|--------------|
| FR-SET-01 | A user can switch between Light, Dark, and System themes; the choice persists.                                                              | Must         |
| FR-SET-02 | A user can toggle notifications on or off; the preference is stored on the server, and when off, no new notifications are created for them. | Must         |
| FR-SET-03 | A user can switch the interface language between English and one additional language; the choice persists.                                  | Must         |
| FR-SET-04 | A user can log out from Settings.                                                                                                           | Must         |

### 3.9 Navigation and UI

| **ID**   | **Requirement**                                                                                                                  | **Priority** |
|----------|----------------------------------------------------------------------------------------------------------------------------------|--------------|
| FR-UI-01 | A persistent navigation bar provides access to Home, Search, Post, Notifications, and Profile, plus Messages and Settings.       | Must         |
| FR-UI-02 | All interactive elements have visible hover, active, focus, and disabled states.                                                 | Must         |
| FR-UI-03 | Data-loading views show skeleton placeholders.                                                                                   | Must         |
| FR-UI-04 | Empty views (no posts, no results, no notifications, no messages) show a meaningful message and, where useful, a call to action. | Must         |
| FR-UI-05 | Successful and failed actions show toast notifications.                                                                          | Must         |
| FR-UI-06 | The UI uses a purple and orange color palette in both light and dark themes.                                                     | Must         |
| FR-UI-07 | Page and component transitions use subtle animations.                                                                            | Could        |

## 4. Non-Functional Requirements

### 4.1 Security

- **NFR-SEC-01:** All endpoints except sign-up, login, and health check require a valid Firebase ID token.

- **NFR-SEC-02:** Users can modify or delete only resources they own; the server enforces this regardless of client behavior.

- **NFR-SEC-03:** All request bodies and parameters are validated with DTOs and class-validator; unknown fields are rejected.

- **NFR-SEC-04:** Secrets (Firebase service account, database credentials, API keys) are stored in environment variables and never committed to Git.

- **NFR-SEC-05:** The API applies rate limiting, with stricter limits on authentication endpoints.

- **NFR-SEC-06:** The live site is served over HTTPS.

- **NFR-SEC-07:** File uploads are validated by type and size on the server, not only on the client.

### 4.2 Data Integrity

- **NFR-DATA-01:** The database enforces uniqueness (email, username, one like per user per post, one save per user per post) with constraints, not only application logic.

- **NFR-DATA-02:** Foreign keys with appropriate delete behavior keep related data consistent (e.g., deleting a post removes its likes, comments, and saves).

- **NFR-DATA-03:** Schema changes are applied through versioned migrations.

### 4.3 Performance

- **NFR-PERF-01:** Feed and list endpoints use cursor-based pagination with a default page size of 10–20 items.

- **NFR-PERF-02:** Frequently queried columns (foreign keys, created_at, username) are indexed.

- **NFR-PERF-03:** Images are displayed with optimized loading (lazy loading, appropriate sizing).

### 4.4 Usability and Responsiveness

- **NFR-UX-01:** The layout adapts correctly to small laptops (~1024–1366 px), standard desktops (~1440–1920 px), and widescreen monitors (2560 px+), and remains usable when the browser window is resized.

- **NFR-UX-02:** The UI meets basic accessibility practice: keyboard navigation, visible focus, alt text, sufficient color contrast in both themes.

### 4.5 Reliability and Operations

- **NFR-OPS-01:** Both applications run under PM2 with automatic restart on crash and on server reboot.

- **NFR-OPS-02:** The API returns errors in a consistent JSON format via a centralized exception filter.

- **NFR-OPS-03:** The API exposes a health check endpoint.

- **NFR-OPS-04:** The API logs requests and errors.

### 4.6 Maintainability

- **NFR-MNT-01:** Code is fully typed TypeScript, with linting (oxlint, including type-aware rules) and formatting (Prettier) enforced.

- **NFR-MNT-02:** A CI pipeline runs lint, type check, build, and tests on every pull request.

- **NFR-MNT-03:** Backend features are separated into NestJS modules; frontend UI is built from reusable components.

- **NFR-MNT-04:** API endpoints are documented with OpenAPI (Swagger).

- **NFR-MNT-05:** Core backend services have unit tests.

## 5. Out of Scope (Won’t Have)

- Video transcoding, adaptive streaming, or a recommendation algorithm.

- Real-time messaging via WebSockets (polling is used instead).

- Password reset, email verification, and social login.

- Native mobile apps.

- Content moderation and admin tools.

- Media attachments in messages.

## 6. Open Questions

1.  What kind of filtering is expected on the Search page? (Assumed: All users / People I follow.)

2.  Is a mobile layout expected, given the brief lists only laptop and desktop sizes? (Assumed: not required.)
