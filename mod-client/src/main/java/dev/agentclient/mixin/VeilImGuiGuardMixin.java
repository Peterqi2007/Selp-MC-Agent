package dev.agentclient.mixin;

import org.lwjgl.glfw.GLFWCharCallback;
import org.lwjgl.glfw.GLFWKeyCallback;
import org.lwjgl.glfw.GLFWScrollCallback;
import org.lwjgl.glfw.GLFWWindowFocusCallback;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Keep Minecraft's keyboard working while skipping Veil's broken ImGui input callback.
 *
 * The pack added Aeronautics -> Sable -> Veil 1.0.0.296. Veil installs an ImGui GLFW key
 * callback that calls {@code ImGui.getIO()} before its editor has a current native context;
 * the first key of any kind aborts the client with:
 *
 * <pre>
 * Dear ImGui Assertion Failed: GImGui != NULL && "No current context..."
 *   at imgui.glfw.ImGuiImplGlfw.keyCallback
 * </pre>
 *
 * The previous attempt cancelled Veil's overridden callback at HEAD. That was wrong: the
 * ImGui callback first chains to the *previous* GLFW callback (Minecraft's KeyboardHandler),
 * so cancelling it disabled every key except mouse buttons, which are handled separately.
 *
 * This mixin instead targets the base ImGui callback, forwards the event to the saved
 * previous callback exactly as ImGuiImplGlfw does, and only skips the ImGui bookkeeping.
 * Minecraft gets all key/char/scroll/focus input; Veil's optional editor loses it.
 */
@Mixin(targets = "imgui.glfw.ImGuiImplGlfw", remap = false)
public abstract class VeilImGuiGuardMixin {

    @Shadow
    private long windowPtr;

    @Shadow
    private GLFWKeyCallback prevUserCallbackKey;

    @Shadow
    private GLFWCharCallback prevUserCallbackChar;

    @Shadow
    private GLFWScrollCallback prevUserCallbackScroll;

    @Shadow
    private GLFWWindowFocusCallback prevUserCallbackWindowFocus;

    @Inject(method = "keyCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$forwardKey(long window, int key, int scancode, int action, int mods, CallbackInfo ci) {
        if (prevUserCallbackKey != null && window == windowPtr) {
            prevUserCallbackKey.invoke(window, key, scancode, action, mods);
        }
        ci.cancel();
    }

    @Inject(method = "charCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$forwardChar(long window, int codepoint, CallbackInfo ci) {
        if (prevUserCallbackChar != null && window == windowPtr) {
            prevUserCallbackChar.invoke(window, codepoint);
        }
        ci.cancel();
    }

    @Inject(method = "scrollCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$forwardScroll(long window, double xoffset, double yoffset, CallbackInfo ci) {
        if (prevUserCallbackScroll != null && window == windowPtr) {
            prevUserCallbackScroll.invoke(window, xoffset, yoffset);
        }
        ci.cancel();
    }

    @Inject(method = "windowFocusCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$forwardFocus(long window, boolean focused, CallbackInfo ci) {
        if (prevUserCallbackWindowFocus != null && window == windowPtr) {
            prevUserCallbackWindowFocus.invoke(window, focused);
        }
        ci.cancel();
    }
}
