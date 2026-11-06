import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type App, deleteApp } from 'firebase-admin/app';
import { firebaseAppProvider } from './firebase-app.provider';
import { FirebaseAuthRestClient } from './firebase-auth-rest.client';
import { FirebaseAuthService } from './firebase-auth.service';
import { FirebaseStorageService } from './firebase-storage.service';
import { FIREBASE_APP } from './firebase.constants';

/**
 * Initialises the Firebase Admin SDK once and provides the Firebase services. Global, so
 * feature modules can inject the services without importing this module; it is imported
 * once, in `AppModule`. Only this module talks to Firebase (design §2.3).
 */
@Global()
@Module({
  providers: [
    firebaseAppProvider,
    FirebaseAuthService,
    FirebaseAuthRestClient,
    FirebaseStorageService,
  ],
  exports: [FirebaseAuthService, FirebaseAuthRestClient, FirebaseStorageService],
})
export class FirebaseModule implements OnApplicationShutdown {
  constructor(@Inject(FIREBASE_APP) private readonly app: App) {}

  /**
   * Releases the SDK's resources on shutdown. Runs after every `onModuleDestroy`
   * hook, so no other module can still be using Firebase. Deleting the named app also
   * lets the e2e tests start a fresh application in the same process.
   */
  async onApplicationShutdown(): Promise<void> {
    await deleteApp(this.app);
  }
}
