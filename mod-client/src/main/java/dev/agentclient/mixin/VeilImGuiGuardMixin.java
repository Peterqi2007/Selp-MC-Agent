package dev.agentclient.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Disable Veil's optional ImGui editor GLFW input.
 *
 * The pack added Aeronautics -> Sable -> Veil 1.0.0.296. Veil installs a GLFW key callback
 * that forwards every key to its ImGui editor. In this pack the native ImGui context is not
 * current (Veil has not rendered an editor frame, or the previous frame failed), so the
 * first key of any kind aborts the client:
 *
 * <pre>
 * Dear ImGui Assertion Failed: GImGui != NULL && "No current context..."
 *   at foundry.veil.impl.client.imgui.VeilImGuiImplGlfw.keyCallback
 * </pre>
 *
 * A runtime "is the context valid?" check is not reliable here: the Java wrapper can still
 * carry a stale non-zero pointer while the native GImGui is null, which is exactly the
 * state that asserts. The editor is optional (F6 shader/resource tools), so this mixin
 * cancels Veil's ImGui input callbacks unconditionally. Minecraft's own keyboard and mouse
 * handling is a separate callback and is not affected; Veil's rendering path is untouched.
 *
 * If the editor is ever needed, remove this mixin (or the Sable/Veil/Aeronautics chain) and
 * use a Veil build that guards its callback itself.
 */
@Mixin(targets = "foundry.veil.impl.client.imgui.VeilImGuiImplGlfw", remap = false)
public abstract class VeilImGuiGuardMixin {

    @Inject(method = "keyCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$guardKey(CallbackInfo ci) {
        ci.cancel();
    }

    @Inject(method = "charCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$guardChar(CallbackInfo ci) {
        ci.cancel();
    }

    @Inject(method = "scrollCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$guardScroll(CallbackInfo ci) {
        ci.cancel();
    }

    @Inject(method = "windowFocusCallback", at = @At("HEAD"), cancellable = true, remap = false)
    private void agentclient$guardFocus(CallbackInfo ci) {
        ci.cancel();
    }
}
